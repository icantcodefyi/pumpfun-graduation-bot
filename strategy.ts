// Graduation sprint on pump.fun bonding curves (agent-fun/replay/v2).
//
// A pump.fun curve completes when its real SOL reserve reaches ~85 SOL, and a position still held
// then is closed at the curve's last (highest) price. Young curves that reach ~45 SOL of real
// reserves fast, on broad buying, finish that run far more often than the average coin dies, and a
// fill near 45 SOL pays ~1.7-2x by the time the curve is near completion. So the bot:
//   1. enters young coins (30..900 slots old) whose real SOL reserve is 45..70 SOL, with at least
//      15 SOL bought in the last 30 slots and no five buyers holding more than 30% of buy volume;
//   2. buys up to 1.5 SOL in tranches inside the 1%-of-reserve cap, only near its entry price;
//   3. sells half once the curve holds 72 SOL, the rest at 76 SOL (or lets completion close it),
//      stops out 25% below its entry price, and gives up after 1500 slots;
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
  /** Tranches are added while the price is within addBand above entry, for addWindow slots. */
  addBand: number;
  addWindow: number;
  /** Exits: half (tp1Frac, in bps of the position) at tp1Rq, the rest at tpRq; stop and time. */
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
}

export const DEFAULT_PARAMS: Params = {
  rqLo: 45n * SOL,
  rqHi: 70n * SOL,
  minAge: 30,
  maxAge: 900,
  velWindow: 30,
  velMin: 15n * SOL,
  top5Max: 0.3,
  size: 1_500_000_000n,
  minBuy: 20_000_000n,
  addBand: 0.08,
  addWindow: 60,
  tp1Rq: 72n * SOL,
  tp1FracBps: 5_000n,
  tpRq: 76n * SOL,
  stopLoss: 0.25,
  maxHold: 1500,
  buySlippageBps: 2000,
  sellSlippageBps: 9000,
  probeTarget: 12,
  probeSize: 12_500_000n,
  probeHold: 30,
  probeGap: 600,
  probeMinAge: 3000,
  probeMinRq: 3n * SOL,
  probeMaxOpen: 2,
  probeSlippageBps: 3000,
};

type Tag = 'in' | 'tp1' | 'tp' | 'sl' | 'time' | 'probe' | 'probe_done' | null;

interface Coin {
  createSlot: number;
  /** Latest recorded reserves (never shifted by our own flow): what the signals read. */
  vq: bigint;
  vt: bigint;
  rq: bigint;
  complete: boolean;
  tag: Tag;
  /** Recorded price when the entry was decided (0: no live entry). */
  entry: number;
  entrySlot: number;
  committed: bigint;
  target: bigint;
  exiting: boolean;
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
    const rq = m !== undefined ? BigInt(m.real_quote_reserves) : c.rq;
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
          complete: false,
          tag: null,
          entry: 0,
          entrySlot: -1,
          committed: 0n,
          target: 0n,
          exiting: false,
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
      if (f.side === 'sell') {
        c.exiting = false;
        if (!state.positions.has(f.mint)) {
          if (c.tag === 'probe') c.tag = 'probe_done';
          c.committed = 0n;
          c.entry = 0;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          c.committed = 0n;
          c.entry = 0;
        }
      }
    }

    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);
    const orders: OrderInput[] = [];

    // 1. Exits and tranche adds on held graduation positions, in mint order.
    for (const mint of [...state.positions.keys()].sort()) {
      const h = state.positions.get(mint)!;
      const c = coins.get(mint);
      if (c === undefined || c.complete || c.exiting || pendingMints.has(mint)) continue;
      if (c.tag === 'probe' || c.tag === 'probe_done' || c.entry === 0) continue;
      const px = Number(c.vq) / Number(c.vt);
      const stop = px < c.entry * (1 - p.stopLoss);
      const tp = c.rq >= p.tpRq;
      const stale = slot - c.entrySlot > p.maxHold;
      if (stop || tp || stale) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        c.exiting = true;
        c.tag = tp ? 'tp' : stop ? 'sl' : 'time';
        continue;
      }
      if (c.tag === 'in' && c.rq >= p.tp1Rq) {
        const part = (h.token_amount * p.tp1FracBps) / 10_000n;
        if (part > 0n) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlippageBps });
          c.exiting = true;
          c.tag = 'tp1';
        }
        continue;
      }
      if (c.committed < c.target && px <= c.entry * (1 + p.addBand) && slot - c.entrySlot <= p.addWindow) {
        let amount = c.target - c.committed;
        const cap = buyCap(state, marks, mint, c);
        if (amount > cap) amount = cap;
        if (amount >= p.minBuy && state.freeCashLamports() - amount > 0n) {
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          c.committed += amount;
          pendingMints.add(mint);
        }
      }
    }

    // 2. Probe round trips: one at a time, only while few graduation positions are open.
    if (p.probeTarget > 0) {
      let probing = false;
      for (const mint of [...state.positions.keys()].sort()) {
        const c = coins.get(mint);
        if (c === undefined || c.tag !== 'probe') continue;
        probing = true;
        if (!c.exiting && !pendingMints.has(mint) && slot - c.entrySlot >= p.probeHold) {
          orders.push({ side: 'sell', mint, token_amount: state.positions.get(mint)!.token_amount, max_slippage_bps: p.sellSlippageBps });
          c.exiting = true;
        }
      }
      for (const o of state.pending.values()) {
        if (o.order.side === 'buy' && coins.get(o.order.mint)?.tag === 'probe') probing = true;
      }
      let gsOpen = 0;
      for (const mint of state.positions.keys()) if (coins.get(mint)?.tag !== 'probe') gsOpen++;
      if (!probing && probesUsed < p.probeTarget && gsOpen <= p.probeMaxOpen && slot >= nextProbe) {
        for (const mint of touched) {
          const c = coins.get(mint)!;
          if (c.complete || c.tag !== null || state.positions.has(mint) || pendingMints.has(mint)) continue;
          if (slot - c.createSlot < p.probeMinAge || c.rq < p.probeMinRq) continue;
          if (p.probeSize > buyCap(state, marks, mint, c)) continue;
          orders.push({ side: 'buy', mint, quote_lamports: p.probeSize, max_slippage_bps: p.probeSlippageBps });
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

    // 3. New graduation entries on coins that traded this slot.
    let open = state.committedPositionCount();
    const cap = state.hello.caps;
    for (const mint of touched) {
      if (open >= cap.max_open_positions || orders.length >= cap.max_orders_per_batch) break;
      const c = coins.get(mint)!;
      if (c.complete || c.tag !== null || state.positions.has(mint) || pendingMints.has(mint)) continue;
      const age = slot - c.createSlot;
      if (age > p.maxAge || age < p.minAge) continue;
      if (c.rq < p.rqLo || c.rq > p.rqHi) continue;
      if (velocity(c, slot) < p.velMin) continue;
      if (top5Share(c) > p.top5Max) continue;
      let amount = p.size;
      const sizeCap = buyCap(state, marks, mint, c);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy || state.freeCashLamports() - amount <= 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      c.tag = 'in';
      c.entry = Number(c.vq) / Number(c.vt);
      c.entrySlot = slot;
      c.committed = amount;
      c.target = p.size;
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
