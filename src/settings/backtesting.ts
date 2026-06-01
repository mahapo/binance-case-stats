import { Matrix, ParamRange } from "../utils";

// Parameter ranges swept by the matrix backtest (`npm run backtest`).
// Each range is {start, end, step}; the runner tests every combination.
export const backtestRanges: ParamRange[] = [
  { key: "leverage", start: 50, end: 150, step: 25 }, // 50, 75, 100
  { key: "ratio", start: 2, end: 4, step: 1 }, // 2, 3, 4   (TP% = ratio × gap%)
  { key: "gapPercent", start: 30, end: 40, step: 10 }, // 30, 40  ("30% SL", …)
  { key: "maxSteps", start: 4, end: 6, step: 1 }, // 4, 6
  { key: "riskPercent", start: 1, end: 2, step: 1 }, // 1%, 2% of balance per trade
  { key: "vipLevel", start: 9, end: 9, step: 1 }, // fee tier: Regular .. VIP 4
];

// Fixed options applied to every combination. Size comes from riskPercent
// (1–2% of the live balance per base trade), so no fixed baseQuantity.
export const backtestBase = {
  symbol: "BTC/USDT",
  startBalance: 1000, // USDT
  lossTakingPolicy: "take-loss" as const,
};

export const backtestMatrix = Matrix.fromRanges(backtestRanges);
