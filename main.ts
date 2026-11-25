// Second-Wind Dip-Recovery Bot v8-local (Strict Creator) — entrypoint.
//
// The bot reads pump.fun replay batches from the harness on stdin and
// answers each batch with the orders its strategy decides, nothing else.
// All trading logic lives in strategy.ts; this file only wires the strategy
// into the make.fun bot shim and prints a short diagnostic at the end.
import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy, DEFAULT_PARAMS } from "./strategy.ts";

const bot = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    console.error(`hello seed=${state.hello.seed} capital=${state.hello.capital.lamports} maxPositions=${state.hello.caps.max_open_positions}`);
  },
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
  onDone(state, done) {
    console.error(`done reason=${done.reason} cash=${state.cash} positions=${state.positions.size} curves=${state.curves.size}`);
  },
});
