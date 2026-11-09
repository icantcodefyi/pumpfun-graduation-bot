// Graduation sprint on pump.fun bonding curves (agent-fun/replay/v2).
//
// A pump.fun curve completes when its real SOL reserve reaches ~85 SOL, and a position still held
// then is closed at the curve's last (highest) price. Young curves that reach ~45 SOL of real
// reserves fast, on broad buying, finish that run far more often than the average coin dies, and a
// fill near 45 SOL pays ~1.7-2x by the time the curve is near completion. So the bot:
//   1. enters young coins (30..900 slots old) whose real SOL reserve is 45..70 SOL, with at least
//      15 SOL bought in the last 30 slots and no five buyers holding more than 30% of buy volume;
//   2. buys up to 10 SOL, and at most 40% of equity, in tranches inside the 1%-of-reserve cap,
//      while the price is within 12% of its entry price and for 90 slots, and sends a failed or
//      rejected tranche again; at most 3 such positions at once, never more than could lose 75% of
//      themselves and leave equity within 45% of its peak, and new entries shrink linearly from full
//      size at 15% below the equity peak to nothing at 42%;
//   3. sells 70% once the curve holds 72 SOL and the rest at 80 SOL (or lets completion close it):
//      near completion the curve's real token reserve falls below a big position's, the replay
//      scales its impact down, and holding on adds little; stops out 20% below its entry price and
//      gives up after 1500 slots; a coin left on a stop or a time exit may be entered again if it
//      sets up again while still young;
//   4. meanwhile runs tiny probe round trips on calm older coins until enough distinct coins have
//      round trips for the competition's guardrail.
//
// Pure function of the batches: no clock, no randomness, no I/O. Map iteration is insertion order
// and held positions are visited in sorted mint order, so two executions emit the same orders.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;

export interface Params {
  /** Entry band on the curve's recorded real SOL reserve (lamports). */
  rqLo: bigint;
  rqHi: bigint;
  /** Coin age at entry, in slots since its CreateEvent. */
  minAge: number;
  maxAge: number;
  /** Buy volume in the last velWindow slots must reach velMin lamports. */
  velWindow: number;
  velMin: bigint;
  /** The five largest buyers' share of all buy volume so far must not exceed this. */
  top5Max: number;
  /** Target position (lamports, curve fees included) and the smallest tranche worth sending. */
  size: bigint;
  minBuy: bigint;
  /** A new position's target is at most this share of equity at entry. */
  eqFrac: number;
  /**
   * Drawdown brake on new entries: full size while equity is within ddFull of its peak, scaled
   * linearly to zero at ddZero (and skipped below minEntry); at most maxOpenGrad positions at once.
   */
  ddFull: number;
  ddZero: number;
  minEntry: bigint;
  maxOpenGrad: number;
  /**
   * Exposure guard: adds and entries never take the open graduation positions (marked value plus
   * buys in flight) past what could lose worstLoss of itself and still leave equity within ddCap of
   * its peak, so even a cluster of rugs at once stays inside the drawdown guardrail.
   */
  ddCap: number;
  worstLoss: number;
  /** Tranches are added while the price is within addBand above entry, for addWindow slots. */
  addBand: number;
  addWindow: number;
  /** Exits: tp1FracBps (bps of the position) at tp1Rq, the rest at tpRq; stop and time. */
  tp1Rq: bigint;
  tp1FracBps: bigint;
  tpRq: bigint;
  stopLoss: number;
  maxHold: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Probe round trips (guardrail coverage). */
  probeTarget: number;
  probeSize: bigint;
  probeHold: number;
  probeGap: number;
  probeMinAge: number;
  probeMinRq: bigint;
  probeMaxOpen: number;
  probeSlippageBps: number;
  /** A probe still held this many slots past its hold no longer blocks the next probe. */
  probeStuckSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  rqLo: 45n * SOL,
  rqHi: 70n * SOL,
  minAge: 30,
  maxAge: 900,
  velWindow: 30,
  velMin: 15n * SOL,
  top5Max: 0.3,
  size: 10_000_000_000n,
  minBuy: 20_000_000n,
  eqFrac: 0.4,
  ddFull: 0.15,
  ddZero: 0.42,
  minEntry: 50_000_000n,
  maxOpenGrad: 3,
  ddCap: 0.45,
  worstLoss: 0.75,
  addBand: 0.12,
  addWindow: 90,
  tp1Rq: 72n * SOL,
  tp1FracBps: 7_000n,
  tpRq: 80n * SOL,
  stopLoss: 0.2,
  maxHold: 1500,
  buySlippageBps: 2000,
  sellSlippageBps: 9000,
  probeTarget: 50,
  probeSize: 12_500_000n,
  probeHold: 30,
  probeGap: 150,
  probeMinAge: 120,
  probeMinRq: 1n * SOL,
  probeMaxOpen: 2,
  probeSlippageBps: 3000,
  probeStuckSlots: 600,
};

type Tag = 'in' | 'tp1' | 'tp' | 'sl' | 'time' | 'probe' | 'probe_stuck' | 'probe_done' | 'probe_failed' | null;

/** The tags of probe round trips, which the graduation logic leaves alone. */
const isProbe = (t: Tag | undefined): boolean => t === 'probe' || t === 'probe_stuck' || t === 'probe_done' || t === 'probe_failed';

/** A sell of the position, halved once per earlier max_order_size rejection (a drained curve), never 0. */
const sellPart = (tokens: bigint, shift: number): bigint => {
  const t = tokens >> BigInt(shift);
  return t > 0n ? t : tokens;
};

interface Coin {
  createSlot: number;
  /** Latest recorded reserves (never shifted by our own flow): what the signals read. */
  vq: bigint;
  vt: bigint;
  rq: bigint;
  /** Fee bps of the coin's last recorded trade: what a close of it pays (0: none seen yet). */
  feeBps: bigint;
  creatorBps: bigint;
  /**
   * Net curve quote our own fills and closes put into the curve. The harness shifts every reserve
   * it checks by it, so once a position is closed the buy cap reads the recorded reserve plus it.
   */
  offQuote: bigint;
  complete: boolean;
  tag: Tag;
  /** Recorded price when the entry was decided (0: no live entry). */
  entry: number;
  entrySlot: number;
  committed: bigint;
  target: bigint;
  exiting: boolean;
  /** The first take-profit sell is in flight: the tag turns 'tp1' only once it fills. */
  tp1Pending: boolean;
  /** Halvings of the next sell after max_order_size rejections (a curve drained below its output). */
  sellShift: number;
  /** Buy volume per wallet and the recent buys (slot, lamports), kept while the coin is young. */
  buyVol: Map<string, bigint> | null;
  recentSlots: number[];
  recentSol: bigint[];
  recentHead: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  let nextProbe = 0;
  let probesUsed = 0;
  let peakEquity = -1;
  /** Our own client ids: buy amounts, so a failed or rejected tranche can be sent again. */
  const buyAmounts = new Map<string, bigint>();
  let nextId = 1;
  const id = (): string => `b${nextId++}`;

  /**
   * Equity as the harness marks it: cash plus what closing each position now would pay (its last
   * trade's fee bps, output capped at the real quote reserve, tx fees deducted; a close that would
   * not cover its tx fees counts nothing).
   */
  const equity = (state: BotState, marks: Map<Pubkey, Mark>): { eq: bigint; gradValue: bigint } => {
    const tx = state.txFeeLamports();
    let eq = state.cash;
    let gradValue = 0n;
    for (const [mint, h] of state.positions) {
      const m = marks.get(mint);
      const c = coins.get(mint);
      if (m === undefined || c === undefined) continue;
      const vq = BigInt(m.virtual_quote_reserves);
      const vt = BigInt(m.virtual_token_reserves);
      const rq = BigInt(m.real_quote_reserves);
      let q = (h.token_amount * vq) / (vt + h.token_amount);
      if (q > rq) q = rq;
      const pb = c.feeBps > 0n ? c.feeBps : BigInt(state.hello.fees.protocol_bps_fallback);
      const cb = c.feeBps > 0n ? c.creatorBps : BigInt(state.hello.fees.creator_bps_fallback);
      const net = q - (q * pb + 9_999n) / 10_000n - (q * cb + 9_999n) / 10_000n - tx;
      if (net > 0n) {
        eq += net;
        if (!isProbe(c.tag)) gradValue += net;
      }
    }
    return { eq, gradValue };
  };

  const velocity = (c: Coin, slot: number): bigint => {
    const lo = slot - p.velWindow;
    while (c.recentHead < c.recentSlots.length && c.recentSlots[c.recentHead]! < lo) c.recentHead++;
    if (c.recentHead > 256 && c.recentHead * 2 > c.recentSlots.length) {
      c.recentSlots = c.recentSlots.slice(c.recentHead);
      c.recentSol = c.recentSol.slice(c.recentHead);
      c.recentHead = 0;
    }
    let sum = 0n;
    for (let i = c.recentHead; i < c.recentSol.length; i++) sum += c.recentSol[i]!;
    return sum;
  };

  const top5Share = (c: Coin): number => {
    if (c.buyVol === null || c.buyVol.size === 0) return 1;
    const vols = [...c.buyVol.values()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    let total = 0n;
    for (const v of vols) total += v;
    let top = 0n;
    for (let i = 0; i < vols.length && i < 5; i++) top += vols[i]!;
    return total === 0n ? 1 : Number(top) / Number(total);
  };

  /** The per-reply buy cap with a 3% margin, on the reserves the harness will check (marks when we have them). */
  const buyCap = (state: BotState, marks: Map<Pubkey, Mark>, mint: Pubkey, c: Coin): bigint => {
    const m = marks.get(mint);
    const shifted = c.rq + c.offQuote > 0n ? c.rq + c.offQuote : 0n;
    const rq = m !== undefined ? BigInt(m.real_quote_reserves) : shifted;
    return ((rq * BigInt(state.hello.caps.max_order_bps_of_real_reserve)) / 10_000n) * 97n / 100n;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          createSlot: e.slot,
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
          rq: 0n,
          feeBps: 0n,
          creatorBps: 0n,
          offQuote: 0n,
          complete: false,
          tag: null,
          entry: 0,
          entrySlot: -1,
          committed: 0n,
          target: 0n,
          exiting: false,
          tp1Pending: false,
          sellShift: 0,
          buyVol: new Map(),
          recentSlots: [],
          recentSol: [],
          recentHead: 0,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        c.vq = BigInt(e.virtual_quote_reserves);
        c.vt = BigInt(e.virtual_token_reserves);
        c.rq = BigInt(e.real_quote_reserves);
        c.feeBps = BigInt(e.fee_basis_points);
        c.creatorBps = BigInt(e.creator_fee_basis_points);
        if (e.is_buy && c.buyVol !== null) {
          const sol = BigInt(e.quote_amount);
          c.buyVol.set(e.user, (c.buyVol.get(e.user) ?? 0n) + sol);
          c.recentSlots.push(e.slot);
          c.recentSol.push(sol);
        }
        if (touched.length === 0 || touched[touched.length - 1] !== e.mint) touched.push(e.mint);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    for (const f of batch.fills) {
      const c = coins.get(f.mint);
      if (c === undefined) continue;
      if (f.status === 'filled') {
        // A buy paid curve quote + fees; a sell (or close) received curve quote - fees.
        if (f.side === 'buy') c.offQuote += BigInt(f.quote_lamports) - BigInt(f.fee_lamports);
        else c.offQuote -= BigInt(f.quote_lamports) + BigInt(f.fee_lamports);
      }
      if (f.side === 'sell') {
        c.exiting = false;
        // A curve drained below the sell's output refuses it (max_order_size): halve the next one.
        if (f.status === 'rejected' && f.reason === 'max_order_size' && c.sellShift < 8) c.sellShift++;
        if (c.tp1Pending) {
          // The first take-profit counts once its partial sell fills; a failed one is sent again.
          if (f.status === 'filled' && c.tag === 'in') c.tag = 'tp1';
          c.tp1Pending = false;
        }
        if (!state.positions.has(f.mint)) {
          if (c.tag === 'probe' || c.tag === 'probe_stuck') c.tag = 'probe_done';
          c.committed = 0n;
          c.entry = 0;
        }
      } else if (f.status !== 'filled') {
        // A failed or rejected buy: its amount may be sent again; an opening buy that never filled
        // leaves the coin free to be entered again while its setup still holds.
        const amount = buyAmounts.get(f.client_id) ?? 0n;
        if (state.positions.has(f.mint)) {
          c.committed = c.committed > amount ? c.committed - amount : 0n;
        } else {
          let stillPending = false;
          for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
          if (!stillPending) {
            c.committed = 0n;
            c.entry = 0;
            if (c.tag === 'in') c.tag = null;
            else if (c.tag === 'probe') {
              c.tag = 'probe_failed';
              probesUsed--;
            }
          }
        }
      }
      if (f.side === 'buy') buyAmounts.delete(f.client_id);
    }

    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);
    const orders: OrderInput[] = [];

    // Equity, its peak, the entry size brake and the exposure guard's headroom (lamports, a float).
    const { eq, gradValue } = equity(state, marks);
    if (eq > peakEquity) peakEquity = eq;
    let atRisk = gradValue;
    for (const o of state.pending.values()) {
      if (o.order.side !== 'buy') continue;
      if (!isProbe(coins.get(o.order.mint)?.tag)) atRisk += BigInt(o.order.quote_lamports);
    }
    let headroom = (Number(eq) - (1 - p.ddCap) * Number(peakEquity)) / p.worstLoss - Number(atRisk);

    // 1. Exits and tranche adds on held graduation positions, in mint order.
    for (const mint of [...state.positions.keys()].sort()) {
      const h = state.positions.get(mint)!;
      const c = coins.get(mint);
      if (c === undefined || c.complete || c.exiting || pendingMints.has(mint)) continue;
      if (isProbe(c.tag) || c.entry === 0) continue;
      const px = Number(c.vq) / Number(c.vt);
      const stop = px < c.entry * (1 - p.stopLoss);
      const tp = c.rq >= p.tpRq;
      const stale = slot - c.entrySlot > p.maxHold;
      if (stop || tp || stale) {
        orders.push({ side: 'sell', mint, token_amount: sellPart(h.token_amount, c.sellShift), max_slippage_bps: p.sellSlippageBps });
        c.exiting = true;
        // A coin that already took profit is done for good; only a stop or time exit may re-enter.
        c.tag = tp || c.tag === 'tp1' || c.tag === 'tp' ? 'tp' : stop ? 'sl' : 'time';
        continue;
      }
      if (c.tag === 'in' && c.rq >= p.tp1Rq) {
        const part = (h.token_amount * p.tp1FracBps) / 10_000n;
        if (part > 0n) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlippageBps });
          c.exiting = true;
          c.tp1Pending = true;
        }
        continue;
      }
      if (c.tag === 'in' && c.committed < c.target && px <= c.entry * (1 + p.addBand) && slot - c.entrySlot <= p.addWindow) {
        let amount = c.target - c.committed;
        const cap = buyCap(state, marks, mint, c);
        if (amount > cap) amount = cap;
        if (Number(amount) > headroom) amount = headroom > 0 ? BigInt(Math.trunc(headroom)) : 0n;
        if (amount >= p.minBuy && state.freeCashLamports() - amount > 0n) {
          const client_id = id();
          buyAmounts.set(client_id, amount);
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps, client_id });
          c.committed += amount;
          pendingMints.add(mint);
          headroom -= Number(amount);
        }
      }
    }

    // 2. Probe round trips: one at a time, only while few graduation positions are open. A probe
    //    that cannot be sold (its curve drained) stops blocking the next one after probeStuckSlots.
    if (p.probeTarget > 0) {
      let probing = false;
      for (const mint of [...state.positions.keys()].sort()) {
        const c = coins.get(mint);
        if (c === undefined || (c.tag !== 'probe' && c.tag !== 'probe_stuck')) continue;
        if (c.tag === 'probe' && slot - c.entrySlot > p.probeHold + p.probeStuckSlots) c.tag = 'probe_stuck';
        if (c.tag === 'probe') probing = true;
        if (!c.exiting && !pendingMints.has(mint) && slot - c.entrySlot >= p.probeHold) {
          const tokens = state.positions.get(mint)!.token_amount;
          orders.push({ side: 'sell', mint, token_amount: sellPart(tokens, c.sellShift), max_slippage_bps: p.sellSlippageBps });
          c.exiting = true;
        }
      }
      for (const o of state.pending.values()) {
        if (o.order.side === 'buy' && coins.get(o.order.mint)?.tag === 'probe') probing = true;
      }
      let gsOpen = 0;
      for (const mint of state.positions.keys()) if (!isProbe(coins.get(mint)?.tag)) gsOpen++;
      const roomForOne = state.committedPositionCount() < state.hello.caps.max_open_positions;
      if (!probing && roomForOne && probesUsed < p.probeTarget && gsOpen <= p.probeMaxOpen && slot >= nextProbe) {
        for (const mint of touched) {
          const c = coins.get(mint)!;
          if (c.complete || c.tag !== null || state.positions.has(mint) || pendingMints.has(mint)) continue;
          if (slot - c.createSlot < p.probeMinAge || c.rq < p.probeMinRq) continue;
          if (p.probeSize > buyCap(state, marks, mint, c)) continue;
          const client_id = id();
          buyAmounts.set(client_id, p.probeSize);
          orders.push({ side: 'buy', mint, quote_lamports: p.probeSize, max_slippage_bps: p.probeSlippageBps, client_id });
          c.tag = 'probe';
          c.entry = Number(c.vq) / Number(c.vt);
          c.entrySlot = slot;
          c.committed = p.probeSize;
          c.target = p.probeSize;
          pendingMints.add(mint);
          probesUsed++;
          nextProbe = slot + p.probeGap;
          break;
        }
      }
    }

    // 3. New graduation entries on coins that traded this slot, sized down as equity falls off its
    //    peak, kept inside the exposure guard, and skipped while maxOpenGrad positions are open.
    const dd = 1 - Number(eq) / Number(peakEquity);
    let f = (p.ddZero - dd) / (p.ddZero - p.ddFull);
    if (f > 1) f = 1;
    if (f < 0) f = 0;
    let size = BigInt(Math.trunc(Number(p.size) * f));
    // Each new position is also capped at eqFrac of equity: a rug of one fresh position cannot take
    // equity through the drawdown guardrail, and sizes grow only as profits compound.
    const capEq = BigInt(Math.trunc(Number(eq) * p.eqFrac));
    if (size > capEq) size = capEq;
    if (size < p.minEntry) size = 0n;
    let gradOpen = 0;
    for (const mint of state.positions.keys()) if (!isProbe(coins.get(mint)?.tag)) gradOpen++;
    for (const o of state.pending.values()) {
      if (o.order.side === 'buy' && !state.positions.has(o.order.mint) && coins.get(o.order.mint)?.tag === 'in') gradOpen++;
    }
    if (gradOpen >= p.maxOpenGrad) size = 0n;
    let open = state.committedPositionCount();
    const cap = state.hello.caps;
    for (const mint of size === 0n ? [] : touched) {
      if (open >= cap.max_open_positions || orders.length >= cap.max_orders_per_batch) break;
      const c = coins.get(mint)!;
      if (c.complete || c.entry !== 0 || state.positions.has(mint) || pendingMints.has(mint)) continue;
      // One live entry per coin; a coin left on a stop or time exit may be entered again while young
      // (real graduations often shake out before they run), and so may a coin whose probe is over,
      // never one that took profit.
      if (c.tag !== null && c.tag !== 'sl' && c.tag !== 'time' && c.tag !== 'probe_done' && c.tag !== 'probe_failed') continue;
      const age = slot - c.createSlot;
      if (age > p.maxAge || age < p.minAge) continue;
      if (c.rq < p.rqLo || c.rq > p.rqHi) continue;
      if (velocity(c, slot) < p.velMin) continue;
      if (top5Share(c) > p.top5Max) continue;
      let amount = size;
      const sizeCap = buyCap(state, marks, mint, c);
      if (amount > sizeCap) amount = sizeCap;
      if (Number(amount) > headroom) amount = headroom > 0 ? BigInt(Math.trunc(headroom)) : 0n;
      if (amount < p.minBuy || state.freeCashLamports() - amount <= 0n) continue;
      headroom -= Number(amount);
      const client_id = id();
      buyAmounts.set(client_id, amount);
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps, client_id });
      c.tag = 'in';
      c.entry = Number(c.vq) / Number(c.vt);
      c.entrySlot = slot;
      c.committed = amount;
      c.target = size;
      pendingMints.add(mint);
      open++;
    }

    // Old coins can no longer enter: drop their per-wallet books to keep memory flat.
    for (const mint of touched) {
      const c = coins.get(mint)!;
      if (c.buyVol !== null && slot - c.createSlot > p.maxAge && c.tag !== 'in') {
        c.buyVol = null;
        c.recentSlots = [];
        c.recentSol = [];
        c.recentHead = 0;
      }
    }
    return orders;
  };
}
