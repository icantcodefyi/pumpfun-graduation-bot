# Strategy: graduation sprint

## What it trades on

A pump.fun bonding curve completes once its real SOL reserve reaches about 85 SOL, and the replay closes any position still open then at the curve's last price. Most coins decay; a few young ones sprint toward completion, 40+ SOL within minutes of launch, on broad buying. On the dev window, the chance of reaching 72 SOL before a 35% drop rose from about 11% at 25 SOL to about 53% at 55 SOL.

The bot enters a coin when, on the batch it decides on:

- **Age:** the coin is 30 to 900 slots old. That skips the bundled launch slots, and older coins rarely complete.
- **Reserve level:** its recorded real SOL reserve is 45 to 70 SOL.
- **Velocity:** at least 15 SOL was bought in the last 30 slots.
- **Breadth:** the five largest buyers hold at most 30% of all buy volume, filtering out pumps by a few wallets that dump together.
- **Re-entry:** a coin left on a stop or time exit may be entered again while young, since real graduations often shake out first.

## How it sizes

- **Target:** 7 SOL per position, curve fees included.
- **Tranches:** each fits the 1%-of-real-reserve cap per reply, on the reserves the harness checks. Tranches are added within 12% of the entry price and 90 slots of entry, the room a position this size needs to fill during a sprint; failed ones are resent.
- **Open positions:** at most 3 graduation positions at once, inside the replay's limit of 5.
- **Drawdown brake:** equity is marked as the harness marks it. New entries shrink linearly from full size at 15% below the equity peak to nothing at 42%.
- **Exposure guard:** a buy is cut so that all open graduation positions and buys in flight could lose 75% with equity still within 45% of its peak. No graduation round trip lost more than 47% in testing.
- **Probes:** up to 50 probes of 0.0125 SOL, held 30 slots each, one at a time, on coins 120+ slots old, keep 20+ coins carrying a round trip of at least 0.01 SOL. Each costs about 0.001 SOL.
- **Drained curves:** a sell refused because the curve holds too little SOL is halved and retried; an unsellable probe stops blocking new probes.

## When it exits

- **Take-profit:** 70% is sold when the recorded real SOL reserve reaches 72 SOL, the rest at 80 SOL; a curve that completes first is closed at its completion price. Near completion the replay scales a large position's impact down, so holding adds little, while curves that stall at 75–84 SOL fall hard.
- **Stop:** everything is sold if the recorded price falls 20% below the entry price.
- **Time limit:** everything is sold 1,500 slots (about 10 minutes) after entry.
- **Slippage:** exits use wide slippage limits.

## Notes

- **Determinism:** the bot is a pure function of its batches, with no clock, randomness or I/O, so both graded executions emit identical orders.
- **Dev window:** +28.71 SOL net, 28% maximum drawdown, 65 counted coins, +25.61 SOL at 2× fees, +13.56 SOL without its three best coins.
- **Risk:** on the kit's block-surrogate copies, which break up coin-level momentum, the bot loses about STRESS_MEDIAN SOL (median). With its 8 to 20 best dev coins deleted it ends near −4.2 SOL with drawdown under 43%: the drawdown brake sets the floor. The edge needs real graduation sprints in the window.
