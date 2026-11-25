[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v8-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v8-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Second-Wind Dip-Recovery Bot v8-local (Strict Creator)

A Solana trading bot for the make.fun **Pump.fun Bot Sprint** bounty. It
trades paper money on a replay of real pump.fun bonding-curve data, ranked
on net PnL over a 6-hour final window it has never seen.

## Idea

Never chase a freshly created coin — new curves rug or stall too often.
Buy only a coin that has already proven it can run (its price once reached
5x its creation price) and is now dipping 15–25% off its peak while buyers
are coming back. The creator may take a little profit, but v8 is strict
about it: once the creator has sold **0.2 SOL** in total, the coin is vetoed
for good, and while holding, a creator sale reaching 0.2 SOL exits the whole
position. Each coin may only ever be entered **once** — no re-entry after an
exit, because the second entry is usually a re-entry into a loser.

## Entry (all must hold)

- Creator sold less than 0.2 SOL; coin is at least 200 slots old.
- Peak price ≥ 5x creation price; peak real SOL ≥ 8; current real SOL ≥ 3.
- Current price is 75–85% of the peak.
- In the last 20 slots: at least 3 buys from at least 3 distinct buyers,
  net flow ≥ 0.02 SOL, the latest trade is a buy, and no single buyer took
  more than 50% of the buy volume.

First buy 0.10 SOL; one add of 0.20 SOL when the price is up 5% from the
first buy, flow is still positive and real SOL ≥ 3. Position cap 0.60 SOL
per coin, 5.0 SOL total exposure, at most 5 open positions.

## Exits (checked before any new entry each batch)

- Sell all: creator veto (≥ 0.2 SOL sold), stop-loss −15%, trailing stop
  −15% off the best value after the TP1 half-sell, TP2 +100% after TP1,
  fade (15-slot net flow < −0.05 SOL), or holding longer than 1200 slots
  (2400 while up ≥ 20%).
- Sell half once at TP1 +20%.
- Sell orders use 10000 bps slippage; position value is the curve quote
  less 1.25% fees and one tx fee. The trailing peak resets to the value
  still held when the TP1 fill arrives.

## Pace probes

To keep the guardrails honest (≥ 20 coins, ≥ 100 fills over the window),
the bot places a 0.01 SOL probe on a recently traded liquid coin whenever
it is behind pace, and sells the probe in full as soon as its buy fills.
Probe fills — buys and sells alike — count toward the pace, and a probe may
revisit a coin it already probed.

## Key parameters

`minRunup 5.0`, `dipMin 0.75`, `dipMax 0.85`, `minPeakRealSol 8`,
`firstSol 0.10`, `addSol 0.20`, `maxPositionSol 0.60`,
`maxExposureSol 5.0`, `tp1 0.20`, `tp2 1.00`, `trail 0.15`,
`stopLoss 0.15`, `maxHold 1200`, `holdIfUp 0.20`, `minAge 200`,
`flowWindow 20`, `minFlowSol 0.02`, `minFlowBuyers 3`,
`maxBuyerShare 0.5`, `minRealSol 3`, `creatorSellVetoSol 0.2`,
`maxEntries 1`, `cooldown 150`, `maxMain 5`, `buySlipBps 1500`,
`targetCoins 22`, `targetFills 100`, `paceSecs 14400`, `probeSol 0.01`.

## Dev-window result (kit replay, run twice, identical)

- Net PnL **−0.042261 SOL**, fills **106**, coins **30**, trips **53**,
  wins **3**, max drawdown **0.0043**, rejected **0**, failed **2**
- Without failed txs: −0.042163 SOL; at 2x fees: −0.074819 SOL
- Guardrails pass: 30 ≥ 20 coins, drawdown 0.0043 ≤ 0.50.
- Baseline v6 (submitted, current best): −0.041989 SOL — v8 is
  0.000272 SOL behind v6, inside noise; the strict creator veto did not
  buy a better net on this window.

## Run

The entrypoint is `main.ts` (Node 22, no dependencies, no build step).
The grader runs `node main.ts`. For a local check, the offline sim in the
build workspace replays the kit dev window through `tools/sim.ts`.
