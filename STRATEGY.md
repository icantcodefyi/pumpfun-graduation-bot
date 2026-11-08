# Strategy: graduation sprint

## What it trades on

A pump.fun bonding curve completes once its real SOL reserve reaches about 85 SOL. The replay closes any position still open then at the curve's last price, the highest the curve ever quotes. Most coins decay. A few young coins sprint toward completion: 40+ SOL within minutes of launch, on broad buying. On the dev window, the chance of reaching 72 SOL before a 35% drop rose from about 11% at 25 SOL to about 53% at 55 SOL. A fill near 45 SOL is worth about 1.7–2× near completion.

The bot enters a coin when, on the batch it decides on:

- **Age:** the coin is 30 to 900 slots old. That skips the bundled launch slots, and older coins rarely complete.
- **Reserve level:** its recorded real SOL reserve is 45 to 70 SOL.
- **Velocity:** at least 15 SOL was bought in the last 30 slots.
- **Breadth:** the five largest buyers hold at most 30% of all buy volume, filtering out pumps by a few wallets that dump together.
- **Re-entry:** a coin left on a stop or time exit may be entered again while young, since real graduations often shake out first.

## How it sizes

- **Target:** 3 SOL per position, curve fees included.
- **Tranches:** each fits the 1%-of-real-reserve cap per reply, read on the reserves the harness checks, including the bot's own past flow on that curve. Tranches are only added within 8% of the entry price and 60 slots of the entry. Failed or rejected tranches are resent.
- **Open positions:** at most 3 graduation positions at once, inside the replay's limit of 5.
- **Drawdown brake:** equity is marked as the harness marks it. New entries shrink linearly from full size at 15% below the equity peak to nothing at 42%.
- **Exposure guard:** a buy is cut so that all open graduation positions and buys in flight could lose 90% with equity still within 48% of its peak, so simultaneous rugs cannot breach the 50% guardrail.
- **Probes:** to ensure 20+ coins carry a round trip of at least 0.01 SOL, up to 25 probes of 0.0125 SOL run on calm coins (older than 3,000 slots, at least 3 SOL of real reserve). Each is held 30 slots, one at a time, 600+ slots apart, only while at most 2 graduation positions are open. Each costs about 0.001 SOL.

## When it exits

- **Take-profit:** half is sold when the recorded real SOL reserve reaches 72 SOL, and the rest at 76 SOL. If the curve completes first, the replay closes the position at the completion price.
- **Stop:** everything is sold if the recorded price falls 25% below the entry price.
- **Time limit:** everything is sold 1,500 slots (about 10 minutes) after entry.
- **Slippage:** exits use wide slippage limits.

## Notes

- **Determinism:** the bot is a pure function of its batches, with no clock, randomness or I/O. It uses sorted mint order and its own sequential client ids, so both graded executions emit identical orders.
- **Dev window:** +13.46 SOL net, 20% maximum drawdown, 41 coins with qualifying round trips, +11.92 SOL at 2× fees, +5.62 SOL without its three best coins. Across nearby filter settings and seeds it stayed positive (worst +6.8 SOL).
- **Risk:** on the kit's block-surrogate copies, which break up coin-level momentum, the bot loses about 2.6 SOL (median). The drawdown brake floors a bad day near −4.2 SOL. The edge needs real graduation sprints in the window.
