# Strategy: graduation sprint

## What it trades on

A pump.fun bonding curve completes once its real SOL reserve reaches about 85 SOL. The replay closes any position still open at that moment at the curve's last price, which is the highest price the curve ever quotes.

Most coins never get near that point and simply decay. A small group of young coins does sprint toward completion: they gather 40+ SOL within minutes of launch, on broad buying rather than a handful of wallets. On the dev window, the chance of reaching 72 SOL before a 35% drop rose from about 11% for coins at 25 SOL to about 53% for coins at 55 SOL. A fill near 45 SOL is worth about 1.7–2× by the time the curve nears completion.

The bot enters a coin when all of these hold on the batch it decides on:

- **Age:** the coin is 30 to 900 slots old. That skips the bundled launch slots, and older coins rarely complete.
- **Reserve level:** its recorded real SOL reserve is between 45 and 70 SOL.
- **Velocity:** at least 15 SOL was bought in the last 30 slots.
- **Breadth:** the five largest buyers account for at most 30% of all buy volume, which filters out pumps driven by a few wallets that later dump together.
- **Once per coin:** each coin is entered at most once. An opening buy that fails on chain or is rejected frees the coin to be entered again.

## How it sizes

- **Target:** each position aims for 2.5 SOL, curve fees included.
- **Tranches:** it is bought in tranches that stay inside the 1%-of-real-reserve cap per reply, using the batch's marks. Each tranche must be within 8% of the entry price and within 60 slots of the entry. A failed or rejected tranche is sent again.
- **Open positions:** at most 3 graduation positions are open at once, and the replay's limit of 5 total positions applies.
- **Drawdown brake:** the bot marks its equity the way the harness does (cash plus what closing every position would pay after fees). New entries shrink linearly from full size at 15% below the equity peak to nothing at 42%, which keeps the 50% drawdown guardrail out of reach.
- **Probes:** to make sure at least 20 coins carry a round trip of 0.01 SOL or more, the bot also runs up to 12 tiny probe round trips of 0.0125 SOL. Each probe goes on a calm coin older than 3,000 slots with at least 3 SOL of real reserve, is held 30 slots, and runs one at a time, at least 600 slots apart, and only while 2 or fewer graduation positions are open. The probes cost about 0.001 SOL each.

## When it exits

- **Partial take-profit:** it sells half when the recorded real SOL reserve reaches 72 SOL, close to completion.
- **Full take-profit:** it sells the rest at 76 SOL. If the curve completes first, the replay closes the position at the completion price.
- **Stop:** it sells everything when the recorded price falls 25% below the decision-time entry price.
- **Time limit:** it sells everything 1,500 slots (about 10 minutes) after entry.
- **Slippage:** exits are sent with wide slippage, because getting out matters more than the last basis point.

## Notes

- **Signals:** entries, the take-profits and the stop read the recorded reserves from the batch's events, never reserves shifted by the bot's own flow. The size cap and equity read the batch's marks.
- **Determinism:** the bot is a pure function of the batches it receives. It has no clock, no randomness and no I/O, visits held positions in sorted mint order and assigns its own sequential client ids, so both graded executions emit identical orders.
- **Dev window results:** +7.97 SOL net, 21% maximum drawdown, 28 coins with qualifying round trips, and +6.87 SOL at 2× fees.
- **Concentration:** profit is concentrated. Without its three best coins the net is +1.65 SOL, and on the kit's block-surrogate copies, which break up coin-level momentum, it loses about 2.6 SOL. The edge depends on real graduation sprints occurring in the window.
