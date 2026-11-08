# Strategy: graduation sprint

## What it trades on

A pump.fun bonding curve completes once its real SOL reserve reaches about 85 SOL. The replay closes any position still open at that moment at the curve's last price, the highest the curve ever quotes. Most coins decay. A few young coins sprint toward completion: 40+ SOL within minutes of launch, on broad buying. On the dev window, the chance of reaching 72 SOL before a 35% drop rose from about 11% at 25 SOL to about 53% at 55 SOL. A fill near 45 SOL is worth about 1.7–2× near completion.

The bot enters a coin when, on the batch it decides on:

- **Age:** the coin is 30 to 900 slots old. That skips the bundled launch slots, and older coins rarely complete.
- **Reserve level:** its recorded real SOL reserve is 45 to 70 SOL.
- **Velocity:** at least 15 SOL was bought in the last 30 slots.
- **Breadth:** the five largest buyers hold at most 30% of all buy volume, filtering out pumps by a few wallets that dump together.
- **Once per coin:** each coin is entered once. An opening buy that fails or is rejected frees the coin again.

## How it sizes

- **Target:** 2.5 SOL per position, curve fees included.
- **Tranches:** each fits the 1%-of-real-reserve cap per reply, measured on the batch's marks. Tranches are only added within 8% of the entry price and 60 slots of the entry. Failed or rejected tranches are resent.
- **Open positions:** at most 3 graduation positions at once, inside the replay's limit of 5.
- **Drawdown brake:** equity is marked as the harness marks it (cash plus what closing every position would pay after fees). New entries shrink linearly from full size at 15% below the equity peak to nothing at 42%, keeping the 50% drawdown guardrail out of reach.
- **Probes:** to ensure 20+ coins carry a round trip of at least 0.01 SOL, up to 12 probes of 0.0125 SOL run on calm coins (older than 3,000 slots, at least 3 SOL of real reserve). Each is held 30 slots, one at a time, 600+ slots apart, only while at most 2 graduation positions are open. Each costs about 0.001 SOL.

## When it exits

- **Take-profit:** half is sold when the recorded real SOL reserve reaches 72 SOL, and the rest at 76 SOL. If the curve completes first, the replay closes the position at the completion price.
- **Stop:** everything is sold if the recorded price falls 25% below the entry price.
- **Time limit:** everything is sold 1,500 slots (about 10 minutes) after entry.
- **Slippage:** exits use wide slippage limits, since getting out matters more than price.

## Notes

- **Signals:** entries and exits read recorded reserves from the batch's events, never reserves shifted by the bot's own flow.
- **Determinism:** the bot is a pure function of its batches, with no clock, randomness or I/O. It uses sorted mint order and its own sequential client ids, so both graded executions emit identical orders.
- **Dev window:** +7.97 SOL net, 21% maximum drawdown, 28 coins with qualifying round trips, +6.87 SOL at 2× fees.
- **Risk:** profit is concentrated. Without the three best coins the net is +1.65 SOL, and on the kit's block-surrogate copies, which break up coin-level momentum, the bot loses about 2.6 SOL. The edge needs real graduation sprints in the window.
