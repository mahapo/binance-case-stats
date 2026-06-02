import * as path from "path";
import { Backtester, BacktestOptions, BacktestResult } from "./runners";
import { PriceLoader } from "./data/PriceLoader";
import { ChartExport, EquityCurve } from "./utils";
import { Tick } from "./data/PriceLoader";
import { backtestMatrix, backtestBase } from "./settings/backtesting";

// Matrix backtest: sweep every parameter combination from
// src/settings/backtesting.ts (vipLevel fixed) over real Binance ticks, report
// the best by net PnL, then replay that best setting across every fee tier
// (vip 0..9) and chart them together to compare the fee impact.
//
//   npm run backtest
//   npm run backtest -- <path-to-tick-csv> <maxTicks>

function main() {
  const csv =
    process.argv[2] ||
    path.resolve(
      __dirname,
      // "../data/BTC/BTCUSDT-trades-2021-04-18.csv",
      // "../data/BTC/Gemini_BTCUSD_tradeprints_Q4_2019.csv",
      "../data/ETH/Gemini_ETHUSD_tradeprints_2019.csv",
    );
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 200_000_000;

  console.log(`Loading ticks from ${csv} (limit ${limit}) …`);
  const ticks = PriceLoader.loadTicks(csv, limit);
  console.log(`Loaded ${ticks.length} ticks.`);
  console.log(`Testing ${backtestMatrix.length} parameter combinations.\n`);

  let best: { options: BacktestOptions; result: BacktestResult } | null = null;

  // side: 0 = buy, 1 = sell, 2 = random (reproducible via this seed).
  const RANDOM_SIDE_SEED = 1337;
  const sideOf = (s: number) =>
    s === 2 ? "random" : s === 1 ? "sell" : "buy";

  backtestMatrix.forEach((combo, i) => {
    const options: BacktestOptions = {
      ...backtestBase, // provides vipLevel (fixed during the sweep)
      ratio: combo.ratio,
      leverage: combo.leverage,
      gapPercent: combo.gapPercent,
      maxSteps: combo.maxSteps,
      maxDrawdownPercent: combo.maxDrawdownPercent, // worst-case series loss as % of balance
      forceSide: combo.side === 2 ? undefined : combo.side === 1 ? "sell" : "buy",
      seed: combo.side === 2 ? RANDOM_SIDE_SEED : undefined,
    };
    const result = new Backtester().run(options, ticks);

    const tag =
      `lev ${combo.leverage}  ratio ${combo.ratio}  gap ${combo.gapPercent}%  ` +
      `maxSteps ${combo.maxSteps}  maxDD ${combo.maxDrawdownPercent}%  ` +
      `${sideOf(combo.side)}`;
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
  const bestSide =
    b.options.forceSide ?? (b.options.seed != null ? "random" : "buy");
  console.log("\n=== BEST (by net PnL) ===");
  console.log(
    `lev ${b.options.leverage}  ratio ${b.options.ratio}  ` +
      `gap ${b.options.gapPercent}%  maxSteps ${b.options.maxSteps}  ` +
      `maxDD ${b.options.maxDrawdownPercent}%  ${bestSide}  vip ${b.options.vipLevel}`
  );
  console.log(`start balance:  ${b.result.startBalance.toFixed(2)} USDT`);
  console.log(`end balance:    ${b.result.balance.toFixed(2)} USDT`);
  console.log(`net PnL:        ${b.result.totalPnL.toFixed(2)} USDT`);
  console.log(`gross / fees:   ${b.result.grossProfit.toFixed(2)} / ${b.result.totalFees.toFixed(2)} USDT`);
  console.log(`series:         ${b.result.seriesCount} (win ${(b.result.winRate * 100).toFixed(1)}%)`);
  console.log(`max hedge step: ${b.result.maxStepReached}`);
  console.log(`max drawdown:   ${b.result.maxDrawdown.toFixed(2)} USDT`);

  // Export the best setting's equity/PnL curve as an SVG chart.
  const settingsTag =
    `lev ${b.options.leverage} · ratio ${b.options.ratio} · gap ${b.options.gapPercent}% · ` +
    `maxSteps ${b.options.maxSteps} · maxDD ${b.options.maxDrawdownPercent}% · ${bestSide} · vip ${b.options.vipLevel}`;
  const chartPath = path.resolve(process.cwd(), "output", "best-pnl.svg");
  ChartExport.writeEquitySvg(
    {
      startBalance: b.result.startBalance,
      finalBalance: b.result.balance,
      equity: b.result.equity,
    },
    chartPath,
    {
      title: "Zone Recovery — best setting (equity / PnL)",
      subtitle: `${settingsTag}  ·  ${b.result.seriesCount} series, ${(b.result.winRate * 100).toFixed(1)}% win, fees ${b.result.totalFees.toFixed(2)} USDT`,
    }
  );
  console.log(`\nChart written: ${chartPath}`);

  // Replay the best setting across every fee tier (vip 0..9) and chart them
  // together to compare the fee impact.
  console.log("\n=== Fee-tier comparison (best setting, vip 0..9) ===");
  const curves: EquityCurve[] = [];
  for (let vip = 0; vip <= 9; vip++) {
    const r = new Backtester().run(
      { ...b.options, vipLevel: vip, feeSchedule: undefined },
      ticks
    );
    console.log(
      `vip ${vip}:  net ${r.totalPnL.toFixed(2)}  ` +
        `(end ${r.balance.toFixed(2)}, fees ${r.totalFees.toFixed(2)})`
    );
    curves.push({
      label: `vip ${vip}`,
      startBalance: r.startBalance,
      finalBalance: r.balance,
      equity: r.equity,
    });
  }
  const cmpPath = path.resolve(process.cwd(), "output", "vip-fee-comparison.svg");
  ChartExport.writeEquityComparisonSvg(curves, cmpPath, {
    title: "Zone Recovery — fee-tier comparison (best setting)",
    subtitle: `${settingsTag.replace(/ · vip \d+/, "")}  ·  equity per fee tier vip 0..9`,
  });
  console.log(`\nComparison chart written: ${cmpPath}`);
}

main();
