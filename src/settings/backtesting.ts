import { Matrix, ParamRange } from "../utils";

// Parameter ranges swept by the matrix backtest (`npm run backtest`).
// Each range is {start, end, step}; the runner tests every combination.
// vipLevel is NOT swept here — the sweep finds the best setting at a fixed fee
// tier (backtestBase.vipLevel below), then the runner replays that best setting
// across vip 0..9 for the fee-comparison chart.
// `side`: 0 = forced buy, 1 = forced sell, 2 = random long/short per series
// (reproducible via a fixed seed in backtest.ts). e.g. set end:2 to sweep all three.
export const backtestRanges: ParamRange[] = [
  { key: "leverage", start: 50, end: 75, step: 25 }, // 150x (max allowed by Binance)
  { key: "ratio", start: 2, end: 3, step: 1 }, // (TP% = ratio × gap%)
  { key: "gapPercent", start: 20, end: 40, step: 10 }, // 30, 40  ("30% SL", …)
  { key: "maxSteps", start: 4, end: 6, step: 1 }, // 4 .. 6 hedge orders
  { key: "maxDrawdownPercent", start: 30, end: 50, step: 10 }, // worst-case series loss: 20/30/40%
  { key: "side", start: 2, end: 2, step: 1 }, // 0 = buy, 1 = sell, 2 = random (set end:2 to include random)
];

// Fixed options applied to every combination. Size is derived from
// maxDrawdownPercent (a fully-lost series costs that % of balance, so the
// balance never goes negative) and capped by the leverage position bracket.
export const backtestBase = {
  symbol: "BTC/USDT",
  startBalance: 10000, // USDT
  lossTakingPolicy: "take-loss" as const,
  vipLevel: 9, // default fee tier for the sweep (compared 0..9 afterwards)
  quote: "USDC" as const,
};

export const backtestMatrix = Matrix.fromRanges(backtestRanges);
