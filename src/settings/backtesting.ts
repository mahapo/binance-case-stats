import { Matrix, ParamRange } from "../utils";

// Parameter ranges swept by the matrix backtest (`npm run backtest`).
// Each range is {start, end, step}; the runner tests every combination.
// vipLevel is NOT swept here — the sweep finds the best setting at a fixed fee
// tier (backtestBase.vipLevel below), then the runner replays that best setting
// across vip 0..9 for the fee-comparison chart.
// `side`: 0 = forced buy, 1 = forced sell, 2 = random long/short per series
// (reproducible via a fixed seed in backtest.ts). e.g. set end:2 to sweep all three.
//
// Trimmed to the values that actually win, measured across the prior runs in
// output/*/summary.json — best-by-net PnL plus a subset-regret check (how much
// of the full sweep's best net each candidate grid still captures on runs that
// contain it). Cuts the grid 720 → 240 combos (3× faster) at ~3–4% average /
// ≤13% worst-case regret. Widen any axis (smaller step / larger end) for finer
// coverage.
//   • leverage   — NOT swept here: it comes from each market's REAL bracket
//                  rungs (LeverageBracket.leverageRungs()), e.g. REDUSDT →
//                  50,25,20,10,5,4,3,2,1×. So only Binance-allowed leverages run.
//   • gapPercent — 20 & 35 are the two dominant gaps; the round {20,30,40}
//                  (dropping 35) regressed ~30%, so 35 is essential.
//   • maxSteps   — 4 wins most runs; a deep 6 is kept for the fee-vs-depth
//                  contrast; adding 5/7 changed nothing.
//   • maxDD%     — full 20..60 ladder (30 was the trend sweet spot, 60 the aggressive end).
//   • ratio      — all of 2..5 stay competitive, so the full axis is kept.
// NOTE: `leverage` is intentionally absent — the runner crosses these ranges with
// the market's own bracket leverage rungs (see src/backtest.ts).
export const backtestRanges: ParamRange[] = [
  { key: "ratio", start: 2, end: 4, step: 1 }, // (TP% = ratio × gap%)
  { key: "gapPercent", start: 20, end: 35, step: 15 }, // {20, 35} — the two winning gaps
  { key: "maxSteps", start: 4, end: 6, step: 2 }, // {4, 6} hedge orders
  { key: "maxDrawdownPercent", start: 20, end: 60, step: 20 }, // {20,30,40,50,60}% worst-case series loss
  { key: "side", start: 2, end: 2, step: 1 }, // 0 = buy, 1 = sell, 2 = random (end:2 ⇒ random only)
];

// Fixed options applied to every combination. Size is derived from
// maxDrawdownPercent (a fully-lost series costs that % of balance, so the
// balance never goes negative) and capped by the leverage position bracket.
export const backtestBase = {
  startBalance: 100_000_000, // USDT — whale simulation ($100M)
  lossTakingPolicy: "take-loss" as const,
  vipLevel: 9, // default fee tier for the sweep (compared 0..9 afterwards)
  // Quote/margin asset → fee table. The runner overrides this from the SYMBOL
  // (…USDC→USDC, …USDT→USDT); this value is only the fallback for symbols with
  // no USDC/USDT suffix (e.g. Gemini …USD files).
  quote: "USDC" as const,
  bnbDiscount: true, // pay fees in BNB → extra 10% off (applied on top of the tier)
};

export const backtestMatrix = Matrix.fromRanges(backtestRanges);
