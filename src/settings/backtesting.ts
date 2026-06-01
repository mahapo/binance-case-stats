import { Matrix, ParamRange } from "../utils";

// Parameter ranges swept by the matrix backtest (`npm run backtest`).
// Each range is {start, end, step}; the runner tests every combination.
export const backtestRanges: ParamRange[] = [
  { key: "leverage", start: 150, end: 150, step: 25 }, // 150x (max allowed by Binance)
  { key: "ratio", start: 3, end: 3, step: 1 }, // (TP% = ratio × gap%)
  { key: "gapPercent", start: 20, end: 40, step: 10 }, // 30, 40  ("30% SL", …)
  { key: "maxSteps", start: 4, end: 6, step: 1 }, // 4 .. 6 hedge orders
  { key: "maxDrawdownPercent", start: 20, end: 40, step: 10 }, // worst-case series loss: 20/30/40%
  { key: "vipLevel", start: 0, end: 9, step: 1 }, // fee tier: Regular .. VIP 9
];

// Fixed options applied to every combination. Size is derived from
// maxDrawdownPercent (a fully-lost series costs that % of balance, so the
// balance never goes negative) and capped by the leverage position bracket.
export const backtestBase = {
  symbol: "BTC/USDT",
  startBalance: 1000, // USDT
  lossTakingPolicy: "take-loss" as const,
  vipLevel: 9, // overridden by matrix
};

export const backtestMatrix = Matrix.fromRanges(backtestRanges);
