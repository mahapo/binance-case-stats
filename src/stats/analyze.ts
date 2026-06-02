#!/usr/bin/env ts-node
import * as fs from "fs";
import * as path from "path";
import { getYear, getYearMonth, listCsv } from "./csv";
import { executionProfile, liquidationProfile } from "./execution";
import { loadOrders, loadTrades, loadTransactions } from "./load";
import { OutcomeBlock, outcomeBlock } from "./outcomes";
import { groupByOrder, reconstructPositions } from "./positions";
import { reconcile } from "./reconcile";
import {
  binomialTest,
  bootstrapMeanCI,
  chiSquareStreakFit,
  expectedRunCounts,
  ljungBox,
  monteCarloMaxStreak,
  runsTest,
  wilsonCI,
} from "./significance";
import { mulberry32 } from "../utils/rng";
import { OUT_DIR, SEED, TRADES_DIR, TX_DIR } from "./paths";

const N_BOOT = 50_000;
const N_SIM = 200_000;
const LJUNG_BOX_LAGS = 20;

function main(): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("Loading USD-M futures data...");
  const trades = loadTrades();
  const transactions = loadTransactions();
  console.log(`  ${trades.length.toLocaleString()} fills, ${transactions.length.toLocaleString()} ledger entries`);

  const orderRecords = loadOrders();
  console.log(`  ${orderRecords.length.toLocaleString()} order records`);

  const recon = reconcile(transactions);
  const orders = groupByOrder(trades);
  const closing = orders.filter((o) => o.hasRealizedProfit);
  const execution = executionProfile(trades, orderRecords, closing);
  const liquidations = liquidationProfile(transactions);

  // Outcome statistics at BOTH order level and economic-position level. Positions
  // are the primary unit (one position = one trade), which removes the partial-close
  // inflation of streaks; order level is kept for fee/notional context and robustness.
  const orderBlock = outcomeBlock(orders);
  const positions = reconstructPositions(trades);
  const positionBlock = outcomeBlock(positions);
  const overallOrders = orderBlock.overall; // order-level: carries traded notional

  const costBps = overallOrders.notional > 0
    ? (Math.abs(recon.totalFees) / overallOrders.notional) * 10000 : null;
  const commissionBps = overallOrders.notional > 0
    ? (Math.abs(recon.commission) / overallOrders.notional) * 10000 : null;

  const validation = {
    closingOrders: orderBlock.overall.nClosing,
    positions: positionBlock.overall.nClosing,
    orderWinRate: orderBlock.overall.winRate,
    positionWinRate: positionBlock.overall.winRate,
    orderMaxLossStreak: orderBlock.overall.maxLossStreak,
    positionMaxLossStreak: positionBlock.overall.maxLossStreak,
    orderRrRatio: orderBlock.overall.rrRatio,
    positionRrRatio: positionBlock.overall.rrRatio,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    scope: "Binance Futures USD-M",
    unit: "economic position (open->flat cycle); order-level under `orders`",
    dataFiles: { trades: listCsv(TRADES_DIR), transactions: listCsv(TX_DIR) },
    reconciliation: recon,
    costBps,
    commissionBps,
    volumeNotional: overallOrders.notional,
    execution,
    liquidations,
    validation,
    // PRIMARY outcome statistics — at economic-position level
    overall: positionBlock.overall,
    distribution: positionBlock.distribution,
    equityCurve: positionBlock.equityCurve,
    sequences: positionBlock.sequences,
    byYear: positionBlock.byYear,
    byMonth: positionBlock.byMonth,
    // Order-level block (robustness / fee context)
    orders: orderBlock,
  };

  fs.writeFileSync(path.join(OUT_DIR, "analysis_data.json"), JSON.stringify(report, null, 2));
  writeMonthlyCsv(report.byMonth);

  // ---- inferential statistics (single source of truth, in TS) ----
  const computed = computeSignificance(positionBlock, recon, costBps, commissionBps, execution, liquidations);
  fs.writeFileSync(path.join(OUT_DIR, "computed_values.json"), JSON.stringify(computed, null, 2));

  printReport(report, validation, execution, liquidations, recon, costBps, commissionBps, computed);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT_DIR)}/{analysis_data.json, computed_values.json, monthly.csv}`);
}

// ---------------------------------------------------------------------------
function computeSignificance(
  block: OutcomeBlock,
  recon: ReturnType<typeof reconcile>,
  costBps: number | null,
  commissionBps: number | null,
  execution: ReturnType<typeof executionProfile>,
  liquidations: ReturnType<typeof liquidationProfile>,
) {
  const rng = mulberry32(SEED);
  const o = block.overall;
  const pnl = block.sequences.closingPnLChrono;
  const wl = block.sequences.winLossSeq;
  const N = pnl.length;

  // Reward/risk-implied fair break-even win rate -> fair-market loss probability.
  const rr = o.rrRatio;
  const breakevenWr = rr > 0 ? 1 / (1 + rr) : NaN;
  const lossRateFair = 1 - breakevenWr;

  const boot = bootstrapMeanCI(pnl, N_BOOT, rng);
  const [wLo, wHi] = wilsonCI(o.winRate, N);

  // Exact binomial: overall + per year (against the fair break-even win rate).
  const binomOverall = binomialTest(o.nWins, o.nClosing, breakevenWr);
  const binomByYear: Record<string, ReturnType<typeof binomialTest> & { winRate: number }> = {};
  for (const [year, s] of Object.entries(block.byYear)) {
    if (s.nClosing > 0) {
      binomByYear[year] = { ...binomialTest(s.nWins, s.nClosing, breakevenWr), winRate: s.winRate };
    }
  }

  const mcFair = monteCarloMaxStreak(N, lossRateFair, N_SIM, o.maxLossStreak, rng);
  const mcOwn = monteCarloMaxStreak(N, o.lossRate, N_SIM, o.maxLossStreak, rng);

  const runs = runsTest(wl, o.nWins, o.nLosses);
  const lb = ljungBox(wl, LJUNG_BOX_LAGS);

  // Observed vs expected loss-streak length frequency.
  const hist = block.sequences.lossStreakHistogram;
  const kmax = Math.max(...Object.keys(hist).map(Number), 1);
  const ks = Array.from({ length: kmax }, (_, i) => i + 1);
  const observed = ks.map((k) => hist[k] || 0);
  const expFair = expectedRunCounts(N, lossRateFair, ks);
  const expOwn = expectedRunCounts(N, o.lossRate, ks);
  const chiFit = chiSquareStreakFit(hist, (k) => expectedRunCounts(N, lossRateFair, [k])[0]);

  return {
    expected_value: {
      mean_pnl_per_trade: boot.meanPnlPerTrade,
      bootstrap_ci95: boot.bootstrapCi95,
      bootstrap_p_mean_ge_0: boot.bootstrapPMeanGe0,
      ttest_t: boot.ttestT,
      ttest_p_two_sided: boot.ttestPTwoSided,
      n_trades: boot.nTrades,
      histogram: boot.histogram,
    },
    win_rate: {
      win_rate: o.winRate,
      wilson_ci95: [wLo, wHi],
      n_trades: N,
      n_wins: o.nWins,
      n_losses: o.nLosses,
      rr_ratio: rr,
      breakeven_win_rate_implied: breakevenWr,
      binomial: binomOverall,
      binomial_by_year: binomByYear,
    },
    max_loss_streak: {
      observed: o.maxLossStreak,
      unit: "economic position",
      n_sims: N_SIM,
      primary_fair_rr_baseline: {
        rr_ratio: rr,
        breakeven_win_rate: breakevenWr,
        sim_loss_rate: lossRateFair,
        p_value_ge_observed: mcFair.pValueGeObserved,
        median_max_streak: mcFair.medianMaxStreak,
        p95_max_streak: mcFair.p95MaxStreak,
        p99_max_streak: mcFair.p99MaxStreak,
        histogram: mcFair.histogram,
      },
      secondary_own_rate_baseline: {
        loss_rate: o.lossRate,
        p_value_ge_observed: mcOwn.pValueGeObserved,
        median_max_streak: mcOwn.medianMaxStreak,
      },
    },
    runs_test: {
      observed_runs: runs.observedRuns,
      expected_runs: runs.expectedRuns,
      z: runs.z,
      p_two_sided: runs.pTwoSided,
      interpretation: runs.interpretation,
    },
    autocorrelation: {
      max_lag: lb.maxLag,
      acf: lb.acf,
      ljung_box_Q: lb.Q,
      df: lb.df,
      p_value: lb.pValue,
    },
    loss_streak_frequency: {
      lengths: ks,
      observed,
      expected_fair_rr: expFair,
      expected_own_rate: expOwn,
      chi_square_fit: chiFit,
    },
    execution_summary: {
      type_counts: execution.typeCounts,
      stop_trigger_rate: execution.stop.triggerRate,
      taker_fill_share: execution.makerTaker.takerFillShare,
      taker_fee_share: execution.makerTaker.takerFeeShare,
      commission_bps: commissionBps,
      exit_types: Object.fromEntries(
        Object.entries(execution.exitTypes).map(([t, e]) => [t, { n: e.n, winRate: e.winRate, sumPnL: e.sumPnL }]),
      ),
      liquidations: { count: liquidations.count, total: liquidations.total },
    },
    meta: {
      n_bootstrap: N_BOOT,
      n_simulations: N_SIM,
      ljung_box_lags: LJUNG_BOX_LAGS,
      seed: SEED,
      fee_to_gross_ratio: recon.feeToGrossRatio,
      cost_bps_of_notional: costBps,
      net_trading_pnl: recon.netTradingPnL,
      binance_reported_net: recon.reportedNet,
      reconciliation_delta: recon.reconciliationDelta,
    },
  };
}

// ---------------------------------------------------------------------------
function writeMonthlyCsv(byMonth: OutcomeBlock["byMonth"]): void {
  const months = Object.keys(byMonth).sort();
  const header = ["Period", "Closing", "Wins", "Losses", "WinRate", "RealPnLClosing",
    "GrossProfit", "GrossLoss", "ProfitFactor", "AvgTrade", "AvgWin", "AvgLoss",
    "RrRatio", "MaxLossStreak", "MaxWinStreak"];
  const rows = months.map((m) => {
    const s = byMonth[m];
    return [m, s.nClosing, s.nWins, s.nLosses, (s.winRate * 100).toFixed(2),
      s.realPnLClosing.toFixed(2), s.grossProfit.toFixed(2), s.grossLoss.toFixed(2),
      s.profitFactor == null ? "" : s.profitFactor.toFixed(3), s.avgTrade.toFixed(2),
      s.avgWin.toFixed(2), s.avgLoss.toFixed(2), s.rrRatio.toFixed(3),
      s.maxLossStreak, s.maxWinStreak].join(",");
  });
  fs.writeFileSync(path.join(OUT_DIR, "monthly.csv"), [header.join(","), ...rows].join("\n"));
}

// ---------------------------------------------------------------------------
function printReport(
  report: any,
  validation: any,
  execution: ReturnType<typeof executionProfile>,
  liquidations: ReturnType<typeof liquidationProfile>,
  recon: ReturnType<typeof reconcile>,
  costBps: number | null,
  commissionBps: number | null,
  computed: any,
): void {
  const fmt = (n: number): string =>
    (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log("\n=== TRANSACTION LEDGER RECONCILIATION (USD-M) ===");
  for (const [type, d] of Object.entries(recon.byType).sort((a: any, b: any) => a[1].total - b[1].total)) {
    const dd = d as { count: number; total: number };
    console.log(`  ${type.padEnd(20)} ${String(dd.count).padStart(7)}  ${fmt(dd.total).padStart(16)}`);
  }
  console.log("  " + "-".repeat(46));
  console.log(`  Gross realized P&L      ${fmt(recon.realizedPnl).padStart(16)}`);
  console.log(`  Total fees              ${fmt(recon.totalFees).padStart(16)}`);
  console.log(`  NET trading P&L         ${fmt(recon.netTradingPnL).padStart(16)}`);
  console.log(`  Binance reported        ${fmt(recon.reportedNet).padStart(16)}`);
  console.log(`  Reconciliation delta    ${fmt(recon.reconciliationDelta).padStart(16)}`);
  console.log(`  Fee-to-gross ratio      ${recon.feeToGrossRatio == null ? "n/a" : recon.feeToGrossRatio.toFixed(1) + "x"}`);
  console.log(`  Effective cost          ${costBps == null ? "n/a" : costBps.toFixed(2) + " bps of notional"}`);

  const pos = report.overall;
  console.log("\n=== TRADE OUTCOMES (economic positions — primary unit) ===");
  console.log(`  Positions               ${pos.nClosing}`);
  console.log(`  Win rate                ${(pos.winRate * 100).toFixed(2)}%  (${pos.nWins} W / ${pos.nLosses} L)`);
  console.log(`  Avg trade (incl. comm.) ${fmt(pos.avgTrade)}`);
  console.log(`  R:R (avgWin/avgLoss)    1:${pos.rrRatio.toFixed(2)}`);
  console.log(`  Max loss streak         ${pos.maxLossStreak}`);
  console.log(`  Profit factor           ${pos.profitFactor == null ? "n/a" : pos.profitFactor.toFixed(3)}`);

  const cv = computed;
  console.log("\n=== INFERENTIAL STATISTICS ===");
  console.log(`  Win rate Wilson 95% CI  ${(cv.win_rate.wilson_ci95[0] * 100).toFixed(2)}% – ${(cv.win_rate.wilson_ci95[1] * 100).toFixed(2)}%  (breakeven ${(cv.win_rate.breakeven_win_rate_implied * 100).toFixed(2)}%)`);
  console.log(`  Binomial vs breakeven   p(one-sided) = ${cv.win_rate.binomial.pLower.toExponential(2)}`);
  console.log(`  Bootstrap mean 95% CI   [${fmt(cv.expected_value.bootstrap_ci95[0])}, ${fmt(cv.expected_value.bootstrap_ci95[1])}]  (t=${cv.expected_value.ttest_t.toFixed(2)}, p=${cv.expected_value.ttest_p_two_sided.toFixed(3)})`);
  console.log(`  Max loss streak ${cv.max_loss_streak.observed}        p(fair R:R)=${cv.max_loss_streak.primary_fair_rr_baseline.p_value_ge_observed.toFixed(4)}  p(own)=${cv.max_loss_streak.secondary_own_rate_baseline.p_value_ge_observed.toFixed(4)}`);
  console.log(`  Runs test               runs=${cv.runs_test.observed_runs}, expected=${cv.runs_test.expected_runs.toFixed(0)}, z=${cv.runs_test.z.toFixed(2)}, p=${cv.runs_test.p_two_sided.toExponential(2)}`);
  console.log(`  Ljung-Box (lag ${cv.autocorrelation.max_lag})       Q=${cv.autocorrelation.ljung_box_Q.toFixed(1)}, p=${cv.autocorrelation.p_value.toExponential(2)}  (acf@1=${cv.autocorrelation.acf[0].toFixed(3)})`);
  const chiFit = cv.loss_streak_frequency.chi_square_fit;
  console.log(`  Chi² streak fit         chi2=${chiFit.chi2.toFixed(1)}, df=${chiFit.df}, p=${chiFit.pValue.toExponential(2)}`);

  console.log("\n=== ROBUSTNESS: order vs position unit ===");
  console.log(`  Closing orders / positions     ${validation.closingOrders} / ${validation.positions}`);
  console.log(`  Win rate  order / position     ${(validation.orderWinRate * 100).toFixed(2)}% / ${(validation.positionWinRate * 100).toFixed(2)}%`);
  console.log(`  Max loss streak order / pos    ${validation.orderMaxLossStreak} / ${validation.positionMaxLossStreak}`);

  console.log("\n=== EXECUTION PROFILE (orders) ===");
  console.log(`  Order records           ${execution.nOrders.toLocaleString()}`);
  console.log(`  Stop orders             ${execution.stop.total} total, ${execution.stop.filled} triggered (${(execution.stop.triggerRate * 100).toFixed(2)}%)`);
  const mt = execution.makerTaker;
  console.log(`  Taker fills             ${mt.takerFills.toLocaleString()} (${(mt.takerFillShare * 100).toFixed(1)}%)  |  Maker fills ${mt.makerFills}`);
  console.log(`  Commission rate         ${commissionBps == null ? "n/a" : commissionBps.toFixed(2) + " bps of notional"}`);

  console.log("\n=== FORCED LIQUIDATIONS (INSURANCE_CLEAR) ===");
  console.log(`  Total                   ${liquidations.count} events, ${fmt(liquidations.total)}`);
}

main();
