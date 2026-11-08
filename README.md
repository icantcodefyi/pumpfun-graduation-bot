# Graduation-sprint bot

A paper-trading bot for make.fun's pump.fun replay (protocol `agent-fun/replay/v2`). It buys young bonding curves that sprint toward completion on broad buying, and takes profit near the top of the curve. [STRATEGY.md](STRATEGY.md) explains the idea, the sizing and the exits.

## Files

- `main.ts`: the entrypoint the grader runs as `node /bot/main.ts`, on Node 22 with type stripping and no install step.
- `strategy.ts`: the strategy, a pure function of the batches it receives.
- `vendor/makefun-bot.ts`: the kit's TypeScript SDK shim, copied byte for byte. It handles the wire protocol.

There are no dependencies beyond Node's standard library. The bot makes no network, clock or file access.

## Grading it locally

From inside the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path to this repository> --driver docker
```

## License

MIT, see [LICENSE](LICENSE).
