import * as fs from "fs";
import * as path from "path";
import { Backtester, BacktestOptions, BacktestResult } from "./runners";
import { PriceLoader, Tick } from "./data/PriceLoader";
import { FeeSchedule, QuoteAsset } from "./models";
import { ChartExport, EquityCurve } from "./utils";

// =============================================================================
// Zone-Recovery "Gutachten" report generator.
//
// Proves the structural fee advantage: place the SAME random trades, change ONLY
// the fee tier, and the outcome flips from loss (Regular User) to profit
// (VIP 9 + BNB + USDC) — independent of market direction. Charts go to a fresh
// timestamped run dir (never overwritten) and are mirrored to
// docs/zone-recovery/charts/ for the report to embed.
//
//   npm run report  [-- <csv> <maxTicks>]
// =============================================================================

// Canonical setting. FIXED base quantity (no balance-dependent sizing) so every
// fee scenario places the *identical* trades — the only variable is the fee.
// "breakeven" loss policy (the documented CAP-EA safety): a maxed-out series is
// wound down at break-even rather than realising the full martingale loss, so
// gross stays a near-fair game and the fee alone drives the result.
const CANON = {
  symbol: "BTC/USDT",
  leverage: 125,
  ratio: 3,
  gapPercent: 20,
  maxSteps: 6,
  baseQuantity: 0.02, // BTC, fixed
  lossTakingPolicy: "breakeven" as const,
  startBalance: 100000, // large enough that no tier runs out → identical trades
};
const SEED0 = 20210223;

// Compounding "consequence" config: size each base trade from the LIVE balance
// (maxDrawdownPercent), so fee differences compound over the whole file. Same
// random trades per seed; only the fee tier differs — but over a full data set
// the Regular User is wiped out while the VIP compounds into the millions.
const COMPOUND = {
  symbol: "BTC/USDT",
  leverage: 50,
  ratio: 3,
  gapPercent: 20,
  maxSteps: 5,
  maxDrawdownPercent: 30,
  lossTakingPolicy: "take-loss" as const,
  startBalance: 10000,
};
// Seed used for the compounding run — matches `npm run backtest` (RANDOM_SIDE_SEED)
// so the two tools produce the same trade sequence and the same dramatic split.
const COMPOUND_SEED = 1337;

// Real-world fee scenarios, from the most expensive (Regular) to the cheapest
// (VIP 9 + BNB + USDC) — the maximum Regular↔VIP gap.
interface Scenario {
  key: string;
  label: string;
  vipLevel: number;
  quote: QuoteAsset;
  bnbDiscount: boolean;
}
const SCENARIOS: Scenario[] = [
  { key: "reg-usdt", label: "Regular · USDT", vipLevel: 0, quote: "USDT", bnbDiscount: false },
  { key: "reg-usdt-bnb", label: "Regular · USDT · BNB", vipLevel: 0, quote: "USDT", bnbDiscount: true },
  { key: "vip3-usdt", label: "VIP 3 · USDT", vipLevel: 3, quote: "USDT", bnbDiscount: false },
  { key: "vip6-usdt", label: "VIP 6 · USDT", vipLevel: 6, quote: "USDT", bnbDiscount: false },
  { key: "vip9-usdt", label: "VIP 9 · USDT", vipLevel: 9, quote: "USDT", bnbDiscount: false },
  { key: "vip9-usdc", label: "VIP 9 · USDC", vipLevel: 9, quote: "USDC", bnbDiscount: false },
  { key: "vip9-usdc-bnb", label: "VIP 9 · USDC · BNB", vipLevel: 9, quote: "USDC", bnbDiscount: true },
];

// 30-day trade-volume thresholds for the VIP tiers (USD), from Binance's fee page.
const VIP_VOLUME_USD = [0, 5e6, 1e7, 5e7, 6e8, 1e9, 2.5e9, 5e9, 1.25e10, 2.5e10];

const scenColor = (i: number) => `hsl(${(i / (SCENARIOS.length - 1)) * 125}, 68%, 45%)`;
const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
const bps = (rate: number) => (rate * 1e4).toFixed(3); // basis points
const takerRate = (s: Scenario) =>
  FeeSchedule.vip(s.vipLevel, { quote: s.quote, bnbDiscount: s.bnbDiscount }).takerRate;

// Round-trip notional traded across the run (entry + exit), i.e. trade volume.
function tradedVolume(r: BacktestResult): number {
  let v = 0;
  for (const o of r.orders) {
    if (o.status !== "closed") continue;
    v += o.amount + o.priceExit * o.quantity;
  }
  return v;
}

function run(ticks: Tick[], over: Partial<BacktestOptions>): BacktestResult {
  return new Backtester().run({ ...CANON, ...over } as BacktestOptions, ticks);
}

function main() {
  const csv =
    process.argv[2] ||
    path.resolve(__dirname, "../data/BTC/Gemini_BTCUSD_tradeprints_Q4_2019.csv");
  // Default: the WHOLE file. Pass a number to cap ticks (useful for huge files).
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : Infinity;

  console.log(`Loading ticks from ${csv} (limit ${limit}) …`);
  const ticks = PriceLoader.loadTicks(csv, limit);
  console.log(`Loaded ${ticks.length} ticks.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.resolve(process.cwd(), "docs/zone-recovery/runs", stamp);
  const chartsDir = path.resolve(process.cwd(), "docs/zone-recovery/charts");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(chartsDir, { recursive: true });
  const emit = (name: string, svg: string) => {
    fs.writeFileSync(path.join(runDir, name), svg);
    fs.writeFileSync(path.join(chartsDir, name), svg);
  };

  // ---------------------------------------------------------------------------
  // PROOF A — identical trades, fee scenario varies.
  // ---------------------------------------------------------------------------
  console.log("\n=== Proof A: identical trades, fee scenario varies ===");
  const rows = SCENARIOS.map((s) => {
    const r = run(ticks, {
      vipLevel: s.vipLevel,
      quote: s.quote,
      bnbDiscount: s.bnbDiscount,
      seed: SEED0,
    });
    return { s, r, volume: tradedVolume(r), rate: takerRate(s) };
  });

  const gross = rows[0].r.grossProfit;
  const grossSpread = Math.max(...rows.map((x) => x.r.grossProfit)) - Math.min(...rows.map((x) => x.r.grossProfit));
  const volume = rows[0].volume;
  const breakEvenRate = gross / volume; // net = gross − volume·rate ⇒ 0 at this rate
  for (const x of rows) {
    console.log(
      `${x.s.label.padEnd(22)} taker ${bps(x.rate)}bps  net ${x.r.totalPnL.toFixed(2).padStart(9)}  ` +
        `(fees ${x.r.totalFees.toFixed(2)}, gross ${x.r.grossProfit.toFixed(2)}, series ${x.r.seriesCount})`
    );
  }
  console.log(`gross identical: ${grossSpread < 1e-6} · volume $${fmt(volume)} · break-even taker ${bps(breakEvenRate)}bps`);

  emit(
    "net-by-fee-scenario.svg",
    ChartExport.barChartSvg(
      rows.map((x, i) => ({ label: x.s.label, value: x.r.totalPnL, color: scenColor(i) })),
      {
        title: "Net result after fees, per fee scenario (identical trades)",
        subtitle: `same gross (${fmt(gross)} $); fees alone flip the sign · break-even taker = ${bps(breakEvenRate)} bps`,
        valueSuffix: " $",
        width: 1180,
      }
    )
  );
  emit(
    "taker-rate-by-scenario.svg",
    ChartExport.barChartSvg(
      rows.map((x, i) => ({ label: x.s.label, value: x.rate * 1e4, color: scenColor(i) })),
      {
        title: "Effective taker fee rate per scenario (basis points)",
        subtitle: `break-even rate for this strategy ≈ ${bps(breakEvenRate)} bps — scenarios above lose, below profit`,
        valueSuffix: " bps",
        width: 1180,
      }
    )
  );

  // ---------------------------------------------------------------------------
  // CONSEQUENCE — compounding over the whole file: Regular → $0, VIP → millions.
  // ---------------------------------------------------------------------------
  // Same logic as `npm run backtest`: one compounding config, replayed across the
  // VIP 0..9 fee tiers (USDC + BNB defaults, seed 1337) — identical trade sequence,
  // only the fee differs. Low-fee tiers compound up; high-fee tiers are wiped out.
  console.log("\n=== Consequence: compounding over the full file, VIP 0..9 (same as backtest) ===");
  const vipGradient = (v: number) => `hsl(${(v / 9) * 125}, 68%, 45%)`;
  const compRows = [];
  for (let vip = 0; vip <= 9; vip++) {
    const r = new Backtester().run(
      { ...COMPOUND, vipLevel: vip, quote: "USDC", bnbDiscount: true, seed: COMPOUND_SEED } as BacktestOptions,
      ticks
    );
    compRows.push({ vip, r });
    console.log(`vip ${vip}:  net ${r.totalPnL.toFixed(2).padStart(14)}  (end ${fmt(r.balance)}, fees ${fmt(r.totalFees)})`);
  }
  const compCurves: EquityCurve[] = compRows.map((c) => ({
    label: `vip ${c.vip}`,
    startBalance: c.r.startBalance,
    finalBalance: c.r.balance,
    equity: c.r.equity,
    color: vipGradient(c.vip),
  }));
  const compSub = `lev ${COMPOUND.leverage} · ratio ${COMPOUND.ratio} · gap ${COMPOUND.gapPercent}% · maxSteps ${COMPOUND.maxSteps} · maxDD ${COMPOUND.maxDrawdownPercent}% · USDC+BNB · from $${fmt(COMPOUND.startBalance)}`;
  // Two versions: log (shows the wiped-out tiers) and linear (shows the scale).
  emit(
    "compounding-by-fee-tier.svg",
    ChartExport.equityComparisonSvg(compCurves, {
      logScale: true,
      title: "Compounded over the full data set — only the fee tier differs (log scale)",
      subtitle: compSub,
    })
  );
  emit(
    "compounding-by-fee-tier-linear.svg",
    ChartExport.equityComparisonSvg(compCurves, {
      title: "Compounded over the full data set — only the fee tier differs (linear scale)",
      subtitle: compSub,
    })
  );

  // ---------------------------------------------------------------------------
  // PROOF B — direction independence: many random seeds, extremes.
  // ---------------------------------------------------------------------------
  console.log("\n=== Proof B: random robustness (Regular vs VIP 9+BNB+USDC) ===");
  const reg = SCENARIOS[0];
  const top = SCENARIOS[SCENARIOS.length - 1];
  const K = 24;
  let regLoss = 0;
  let topWin = 0;
  const regNet: number[] = [];
  const topNet: number[] = [];
  for (let k = 0; k < K; k++) {
    const seed = SEED0 + k * 7919;
    const r0 = run(ticks, { vipLevel: reg.vipLevel, quote: reg.quote, bnbDiscount: reg.bnbDiscount, seed });
    const r9 = run(ticks, { vipLevel: top.vipLevel, quote: top.quote, bnbDiscount: top.bnbDiscount, seed });
    if (r0.totalPnL < 0) regLoss++;
    if (r9.totalPnL > 0) topWin++;
    regNet.push(r0.totalPnL);
    topNet.push(r9.totalPnL);
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`Regular · USDT:       ${regLoss}/${K} lost · mean net ${mean(regNet).toFixed(2)}`);
  console.log(`VIP 9 · USDC · BNB:   ${topWin}/${K} won  · mean net ${mean(topNet).toFixed(2)}`);

  // ---------------------------------------------------------------------------
  // How it works — price + 3 series (same style as output/trades.svg). Uses a
  // wider gap (ratio 2) so the hedges are spaced over time and the recovery
  // staircase is visible on the price line rather than piled at one timestamp.
  // ---------------------------------------------------------------------------
  const canonR = new Backtester().run(
    {
      symbol: "BTC/USDT",
      leverage: 75,
      ratio: 2,
      gapPercent: 70,
      maxSteps: 6,
      maxDrawdownPercent: 25,
      lossTakingPolicy: "take-loss",
      startBalance: 10000,
      vipLevel: 9,
      quote: "USDC",
      bnbDiscount: true,
      seed: COMPOUND_SEED,
    } as BacktestOptions,
    ticks
  );
  // Group every closed order by series, then pick the calmest cluster of 3
  // consecutive series (smallest entry-price spread) so the zones and the
  // recovery staircase are clearly visible rather than squashed by a trend.
  const allBySeries = new Map<number, typeof canonR.orders>();
  for (const o of canonR.orders) {
    if (o.status !== "closed" || o.seriesId == null) continue;
    const id = o.seriesId as number;
    const arr = allBySeries.get(id) ?? [];
    arr.push(o);
    allBySeries.set(id, arr);
  }
  const completed = canonR.series.filter((s) => allBySeries.has(s.seriesId as number));
  // Pick the window of 3 consecutive series with the MOST hedge activity (deepest
  // recoveries) so the staircase is actually shown, not trivial 1-step wins.
  let pick = 0;
  let pickSteps = -1;
  for (let i = 0; i + 3 <= completed.length; i++) {
    const steps = completed[i].steps + completed[i + 1].steps + completed[i + 2].steps;
    if (steps > pickSteps) {
      pickSteps = steps;
      pick = i;
    }
  }
  const shown = completed.slice(pick, pick + 3);
  if (shown.length > 0) {
    const vizSeries = shown.map((s) => ({
      seriesId: s.seriesId,
      outcome: s.outcome,
      grossProfit: s.grossProfit,
      netProfit: s.netProfit,
      orders: (allBySeries.get(s.seriesId as number) ?? []).map((o, i) => ({
        step: i + 1,
        side: o.side as "buy" | "sell",
        entry: o.price,
        stopLoss: o.stopLoss as number,
        takeProfit: o.takeProfit as number,
        quantity: o.quantity,
        pnl: o.pnl,
        fillTime: o.timestampFilled ?? 0,
        exitTime: o.timestampExit ?? o.timestampFilled ?? 0,
        exitPrice: o.priceExit,
        hit: (o.priceExit === o.takeProfit ? "tp" : o.priceExit === o.stopLoss ? "sl" : "open") as "tp" | "sl" | "open",
      })),
    }));
    const stamps = vizSeries.flatMap((s) => s.orders.flatMap((o) => [o.fillTime, o.exitTime])).filter((t) => t > 0);
    const padT = (Math.max(...stamps) - Math.min(...stamps)) * 0.03 || 1000;
    const winTicks = ticks.filter((t) => t.time >= Math.min(...stamps) - padT && t.time <= Math.max(...stamps) + padT);
    emit(
      "how-it-works.svg",
      ChartExport.tradesSvg({
        ticks: winTicks,
        series: vizSeries,
        title: "Zone Recovery — how it works (3 series)",
        subtitle: `lev 75 · ratio 2 · gap 70% · maxSteps 6 · price (grey), gap zone, TP envelope (green), numbered entries with lots`,
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Summary.
  // ---------------------------------------------------------------------------
  const summary = {
    generatedAt: new Date().toISOString(),
    data: { csv: path.basename(csv), ticks: ticks.length },
    canonical: CANON,
    seed: SEED0,
    grossProfit: gross,
    grossIdenticalAcrossScenarios: grossSpread < 1e-6,
    grossSpread,
    tradedVolumeUsd: volume,
    breakEvenTakerBps: breakEvenRate * 1e4,
    vip9VolumeThresholdUsd: VIP_VOLUME_USD[9],
    scenarios: rows.map((x) => ({
      key: x.s.key,
      label: x.s.label,
      takerBps: x.rate * 1e4,
      net: x.r.totalPnL,
      end: x.r.balance,
      fees: x.r.totalFees,
      gross: x.r.grossProfit,
      series: x.r.seriesCount,
    })),
    robustness: { seeds: K, regularLosses: regLoss, vipWins: topWin, regularMeanNet: mean(regNet), vipMeanNet: mean(topNet) },
    compounding: {
      config: COMPOUND,
      seed: COMPOUND_SEED,
      quote: "USDC+BNB",
      perVip: compRows.map((c) => ({ vip: c.vip, net: c.r.totalPnL, end: c.r.balance, fees: c.r.totalFees, series: c.r.seriesCount })),
    },
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(chartsDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\nRun written to:   ${runDir}`);
  console.log(`Canonical charts: ${chartsDir}`);
}

main();
