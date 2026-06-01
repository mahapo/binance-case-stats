import * as path from "path";
import { Backtester, BacktestOptions, BacktestResult } from "./runners";
import { PriceLoader } from "./data/PriceLoader";
import { backtestMatrix, backtestBase } from "./settings/backtesting";

// Matrix backtest: sweep every parameter combination from
// src/settings/backtesting.ts over real Binance ticks and report the best.
//
//   npm run backtest
//   npm run backtest -- <path-to-tick-csv> <maxTicks>

function main() {
  const csv =
    process.argv[2] ||
    path.resolve(
      __dirname,
      "../data/BTC/Gemini_BTCUSD_tradeprints_Q4_2019.csv",
    );
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 200_000_000;

  console.log(`Loading ticks from ${csv} (limit ${limit}) …`);
  const ticks = PriceLoader.loadTicks(csv, limit);
  console.log(`Loaded ${ticks.length} ticks.`);
  console.log(`Testing ${backtestMatrix.length} parameter combinations.\n`);

  let best: { options: BacktestOptions; result: BacktestResult } | null = null;

  backtestMatrix.forEach((combo, i) => {
    const options: BacktestOptions = {
      ...backtestBase,
      ratio: combo.ratio,
      leverage: combo.leverage,
      gapPercent: combo.gapPercent,
      maxSteps: combo.maxSteps,
      riskPercent: combo.riskPercent, // 1–2% of balance per base trade
      vipLevel: combo.vipLevel, // fee tier 0..4 → FeeSchedule.vip(level)
    };
    const result = new Backtester().run(options, ticks);

    const tag =
      `lev ${combo.leverage}  ratio ${combo.ratio}  gap ${combo.gapPercent}%  ` +
      `maxSteps ${combo.maxSteps}  risk ${combo.riskPercent}%  vip ${combo.vipLevel}`;
    console.log(
      `[${i + 1}/${backtestMatrix.length}] ${tag}  →  ` +
        `net ${result.totalPnL.toFixed(2)}  ` +
        `(gross ${result.grossProfit.toFixed(2)}, fees ${result.totalFees.toFixed(2)}, ` +
        `series ${result.seriesCount}, win ${(result.winRate * 100).toFixed(0)}%, ` +
        `maxStep ${result.maxStepReached}, maxDD ${result.maxDrawdown.toFixed(2)})`
    );

    if (!best || result.totalPnL > best.result.totalPnL) {
      best = { options, result };
    }
  });

  if (!best) return;
  const b = best as { options: BacktestOptions; result: BacktestResult };
  console.log("\n=== BEST (by net PnL) ===");
  console.log(
    `lev ${b.options.leverage}  ratio ${b.options.ratio}  ` +
      `gap ${b.options.gapPercent}%  maxSteps ${b.options.maxSteps}  ` +
      `risk ${b.options.riskPercent}%  vip ${b.options.vipLevel}`
  );
  console.log(`start balance:  ${b.result.startBalance.toFixed(2)} USDT`);
  console.log(`end balance:    ${b.result.balance.toFixed(2)} USDT`);
  console.log(`net PnL:        ${b.result.totalPnL.toFixed(2)} USDT`);
  console.log(`gross / fees:   ${b.result.grossProfit.toFixed(2)} / ${b.result.totalFees.toFixed(2)} USDT`);
  console.log(`series:         ${b.result.seriesCount} (win ${(b.result.winRate * 100).toFixed(1)}%)`);
  console.log(`max hedge step: ${b.result.maxStepReached}`);
  console.log(`max drawdown:   ${b.result.maxDrawdown.toFixed(2)} USDT`);
}

main();
