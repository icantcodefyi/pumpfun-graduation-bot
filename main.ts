// Graduation-sprint bot for make.fun's pump.fun replay (agent-fun/replay/v2), see STRATEGY.md.
// Run by the grader as `node /bot/main.ts` (Node 22 type stripping, no install step). The SDK shim
// is vendored byte for byte in vendor/; the strategy lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const onBatch = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch });
