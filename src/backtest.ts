import * as fs from "fs";
import * as path from "path";
import { Backtester, BacktestOptions, BacktestResult } from "./runners";
import { PriceLoader } from "./data/PriceLoader";
import { resolveData } from "./data/downloadAggTrades";
import { ChartExport, EquityCurve } from "./utils";
import { LeverageBracket, FeeSchedule, QuoteAsset } from "./models";
import { backtestMatrix, backtestBase } from "./settings/backtesting";

// Matrix backtest: sweep every parameter combination from
// src/settings/backtesting.ts (vipLevel fixed) over real Binance ticks, report
// the best by net PnL, then replay that best setting across every fee tier
// (vip 0..9). All artifacts for the best run are written to
//   output/<SYMBOL>-<bestId>/  (best-pnl.svg, vip-fee-comparison.svg,
//                               trades.csv, summary.json)
// plus latest copies at output/best-pnl.svg and output/vip-fee-comparison.svg.
//
//   npm run backtest                              (default file)
//   npm run backtest -- <SYMBOL> <PERIOD> [limit] (auto-download, e.g. AVAXUSDT 2026-05)
//   npm run backtest -- <path-to-tick-csv> [limit]

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));

/** Base coin of a market symbol, e.g. AVAXUSDC → AVAX, BTCUSDT → BTC. */
const baseCoin = (s: string) => s.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/i, "");

/** Quote/margin asset from a symbol → its fee table. …USDC→USDC, …USDT→USDT. */
const quoteFromSymbol = (s: string): QuoteAsset | undefined =>
  /USDC$/i.test(s) ? "USDC" : /USDT$/i.test(s) ? "USDT" : undefined;

/** Round-trip notional traded across the run (entry + exit), i.e. trade volume. */
function tradedVolume(r: BacktestResult): number {
  let v = 0;
  for (const o of r.orders) {
    if (o.status !== "closed") continue;
    v += o.amount + o.priceExit * o.quantity;
  }
  return v;
}

/** One row per order — the full trade log of a run. */
function toTradesCsv(r: BacktestResult): string {
  const head =
    "seriesId,side,quantity,entryPrice,notional,stopLoss,takeProfit,exitPrice,pnl,feeRoundTrip,status,outcome,fillTime,exitTime";
  const rows = r.orders.map((o) => {
    const outcome =
      o.priceExit === o.takeProfit ? "tp" : o.priceExit === o.stopLoss ? "sl" : "";
    return [
      o.seriesId ?? "",
      o.side,
      o.quantity,
      o.price,
      o.amount,
      o.stopLoss ?? "",
      o.takeProfit ?? "",
      o.priceExit,
      o.pnl.toFixed(8),
      o.feeRoundTrip.toFixed(8),
      o.status,
      outcome,
      o.timestampFilled ?? "",
      o.timestampExit ?? "",
    ].join(",");
  });
  return [head, ...rows].join("\n");
}

async function main() {
  // Args: <SYMBOL> <PERIOD> [limit]            (auto-download, e.g. AVAXUSDT 2026-05)
  //   or  <SYMBOL> <START> <END> [limit]       (range, e.g. SUIUSDC 2025-10 2026-01)
  //   or  <csv-path> [limit]  or  (none → default file)
  const { csvs, limit, label } = await resolveData(process.argv, {
    defaultCsv: path.resolve(
      __dirname,
      "../data/BTC/Gemini_BTCUSD_tradeprints_Q4_2019.csv",
      // "../data/ETH/Gemini_ETHUSD_tradeprints_2019.csv",
    ),
    defaultLimit: 200_000_000,
  });

  // Market + its real per-market leverage brackets (from the ccxt cache).
  const symbol = PriceLoader.symbolFromPath(csvs[0]) || "BTCUSDT";
  const coin = baseCoin(symbol);
  const leverageBracket = LeverageBracket.forSymbol(symbol);

  // The margin/quote asset — and therefore the fee table — follows the symbol:
  //   …USDC → USDC fees (0% maker, lower taker),  …USDT → USDT fees.
  // Symbols without a USDC/USDT suffix (e.g. Gemini …USD) fall back to the default.
  const quote: QuoteAsset = quoteFromSymbol(symbol) ?? backtestBase.quote;
  const bnbDiscount = backtestBase.bnbDiscount;

  console.log(
    `Loading ticks from ${label} (${csvs.length} file${csvs.length > 1 ? "s" : ""}, limit ${limit}) …`
  );
  const ticks = PriceLoader.loadTicksMany(csvs, limit);
  const firstTime = ticks[0]?.time;
  const lastTime = ticks[ticks.length - 1]?.time;
  const days = ticks.length > 1 ? (lastTime - firstTime) / 86_400_000 : 0;
  const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
  const period = ticks.length > 1 ? `${isoDay(firstTime)} → ${isoDay(lastTime)}` : "n/a";
  console.log(`Loaded ${ticks.length} ticks. Market: ${symbol}. Period: ${period} (${days.toFixed(2)} days).`);
  // Leverage is swept from THIS market's real bracket rungs (every Binance-allowed
  // leverage, each with its own position cap) — crossed with the parameter matrix.
  // So we only ever test leverages the market actually permits.
  const levRungs = leverageBracket.leverageRungs();
  const combos: Record<string, number>[] = levRungs.flatMap((leverage) =>
    backtestMatrix.map((c) => ({ ...c, leverage }))
  );
  console.log(`Leverage rungs (${symbol} brackets): ${levRungs.join(", ")}×`);
  console.log(
    `Testing ${combos.length} combinations (${levRungs.length} leverage × ${backtestMatrix.length} params).\n`
  );

  // side: 0 = buy, 1 = sell, 2 = random (reproducible via this seed).
  const RANDOM_SIDE_SEED = 1337;
  const sideOf = (s: number) => (s === 2 ? "random" : s === 1 ? "sell" : "buy");

  let best: { options: BacktestOptions; result: BacktestResult } | null = null;
  const allResults: any[] = [];

  combos.forEach((combo, i) => {
    const options: BacktestOptions = {
      ...backtestBase, // provides vipLevel (fixed during the sweep)
      symbol,
      quote, // fee table follows the symbol (USDC vs USDT)
      leverageBracket, // real per-market position limits
      ratio: combo.ratio,
      leverage: combo.leverage,
      gapPercent: combo.gapPercent,
      maxSteps: combo.maxSteps,
      maxDrawdownPercent: combo.maxDrawdownPercent, // worst-case series loss as % of balance
      forceSide: combo.side === 2 ? undefined : combo.side === 1 ? "sell" : "buy",
      seed: combo.side === 2 ? RANDOM_SIDE_SEED : undefined,
    };
    const result = new Backtester().run(options, ticks);

    allResults.push({
      leverage: combo.leverage,
      ratio: combo.ratio,
      gapPercent: combo.gapPercent,
      maxSteps: combo.maxSteps,
      maxDrawdownPercent: combo.maxDrawdownPercent,
      side: sideOf(combo.side),
      net: result.totalPnL,
      gross: result.grossProfit,
      fees: result.totalFees,
      series: result.seriesCount,
      winRate: result.winRate,
      maxStep: result.maxStepReached,
      maxDrawdown: result.maxDrawdown,
    });

    const tag =
      `lev ${combo.leverage}  ratio ${combo.ratio}  gap ${combo.gapPercent}%  ` +
      `maxSteps ${combo.maxSteps}  maxDD ${combo.maxDrawdownPercent}%  ${sideOf(combo.side)}`;
    console.log(
      `[${i + 1}/${combos.length}] ${tag}  →  net ${result.totalPnL.toFixed(2)}  ` +
        `(gross ${result.grossProfit.toFixed(2)}, fees ${result.totalFees.toFixed(2)}, ` +
        `series ${result.seriesCount}, win ${(result.winRate * 100).toFixed(0)}%, ` +
        `maxStep ${result.maxStepReached}, maxDD ${result.maxDrawdown.toFixed(2)})`
    );

    // Only a combo that actually traded can be "best" — otherwise an empty
    // net-0 run would beat every (losing) real run and produce a hollow report.
    if (result.seriesCount > 0 && (!best || result.totalPnL > best.result.totalPnL)) {
      best = { options, result };
    }
  });

  if (!best) {
    console.log(
      `\nNo combination opened a single series on this data — the window is likely too ` +
        `short/flat for these gaps. Try a longer period or a smaller gapPercent.`
    );
    return;
  }
  const b = best as { options: BacktestOptions; result: BacktestResult };
  const o = b.options;
  const bestSide = o.forceSide ?? (o.seed != null ? "random" : "buy");
  const lev = o.leverage!;
  const maxNotional = leverageBracket.maxPositionValue(lev);
  const maxPositionQty = leverageBracket.limits.maxPositionQty;
  const volume = tradedVolume(b.result);
  const volumePerDay = days > 0 ? volume / days : 0;

  // Fee config (the project's thesis): the quote (USDC/USDT, from the symbol)
  // picks the fee table; BNB adds another 10% off. USDC < USDT at every tier.
  const pct = (r: number) => (r * 100).toFixed(4) + "%";
  const bnbTag = bnbDiscount ? "BNB −10%" : "no BNB";
  const bestFee = FeeSchedule.vip(o.vipLevel ?? 0, { quote, bnbDiscount });
  // Effective rates if the same tier were charged on the OTHER quote — for contrast.
  const otherQuote: QuoteAsset = quote === "USDC" ? "USDT" : "USDC";
  const otherFee = FeeSchedule.vip(o.vipLevel ?? 0, { quote: otherQuote, bnbDiscount });
  const feeLine =
    `${quote} margin · ${bnbTag} · vip ${o.vipLevel} → ` +
    `taker ${pct(bestFee.takerRate)} / maker ${pct(bestFee.makerRate)}` +
    `  (${otherQuote} would be taker ${pct(otherFee.takerRate)} / maker ${pct(otherFee.makerRate)})`;
  const feeNote = `${quote} · ${bnbTag} · taker ${pct(bestFee.takerRate)}`; // compact, for charts

  console.log("\n=== BEST (by net PnL) ===");
  console.log(`market:         ${symbol}`);
  console.log(
    `setting:        lev ${lev}  ratio ${o.ratio}  gap ${o.gapPercent}%  ` +
      `maxSteps ${o.maxSteps}  maxDD ${o.maxDrawdownPercent}%  ${bestSide}  vip ${o.vipLevel}`
  );
  console.log(`start balance:  ${b.result.startBalance.toFixed(2)} USDT`);
  console.log(`end balance:    ${b.result.balance.toFixed(2)} USDT`);
  console.log(`net PnL:        ${b.result.totalPnL.toFixed(2)} USDT`);
  console.log(`gross / fees:   ${b.result.grossProfit.toFixed(2)} / ${b.result.totalFees.toFixed(2)} USDT`);
  console.log(`fee tier:       ${feeLine}`);
  console.log(`series:         ${b.result.seriesCount} (win ${(b.result.winRate * 100).toFixed(1)}%)`);
  console.log(`max hedge step: ${b.result.maxStepReached}`);
  console.log(`max drawdown:   ${b.result.maxDrawdown.toFixed(2)} USDT`);
  console.log(
    `max bracket:    $${fmt(maxNotional)} notional @ ${lev}× · ` +
      `${maxPositionQty != null ? fmt(maxPositionQty) + " " + coin + " max position" : "no qty limit"}`
  );
  console.log(`period:         ${period} (${days.toFixed(2)} days)`);
  console.log(`trade volume:   $${fmt(volume)} total · $${fmt(volumePerDay)}/day`);

  // ---- Output folder for the best run -------------------------------------
  // Folder id carries the market, the data date range, and the winning params.
  const dFrom = isoDay(firstTime!);
  const dTo = isoDay(lastTime!);
  const dateTag = dFrom === dTo ? dFrom : `${dFrom}_${dTo}`;
  const bestId =
    `lev${lev}-r${o.ratio}-gap${o.gapPercent}-ms${o.maxSteps}-dd${o.maxDrawdownPercent}-${bestSide}-vip${o.vipLevel}`;
  const folderId = `${symbol}-${dateTag}-${bestId}`;
  const outDir = path.resolve(process.cwd(), "output", folderId);
  fs.mkdirSync(outDir, { recursive: true });
  const outTop = path.resolve(process.cwd(), "output");

  const settingsTag =
    `lev ${lev} · ratio ${o.ratio} · gap ${o.gapPercent}% · maxSteps ${o.maxSteps} · ` +
    `maxDD ${o.maxDrawdownPercent}% · ${bestSide} · vip ${o.vipLevel}`;

  // Best equity/PnL chart (now shows the market) — to the folder + latest copy.
  const bestSvg = ChartExport.equitySvg(
    { startBalance: b.result.startBalance, finalBalance: b.result.balance, equity: b.result.equity },
    {
      title: `Zone Recovery — ${symbol} best setting (equity / PnL)`,
      subtitle: `${settingsTag}  ·  ${b.result.seriesCount} series, ${(b.result.winRate * 100).toFixed(1)}% win · vol $${fmt(volume)} ($${fmt(volumePerDay)}/day) · fees $${fmt(b.result.totalFees)}`,
      note: feeNote,
      priceSeries: ticks, // overlay the market price (secondary right axis)
    }
  );
  fs.writeFileSync(path.join(outDir, "best-pnl.svg"), bestSvg);
  fs.writeFileSync(path.join(outTop, "best-pnl.svg"), bestSvg);

  // Trade log CSV.
  fs.writeFileSync(path.join(outDir, "trades.csv"), toTradesCsv(b.result));

  // ---- Fee-tier comparison (best setting, vip 0..9) -----------------------
  console.log("\n=== Fee-tier comparison (best setting, vip 0..9) ===");
  const curves: EquityCurve[] = [];
  const vipComparison: any[] = [];
  for (let vip = 0; vip <= 9; vip++) {
    const r = new Backtester().run({ ...b.options, vipLevel: vip, feeSchedule: undefined }, ticks);
    const f = FeeSchedule.vip(vip, { quote, bnbDiscount });
    console.log(
      `vip ${vip}:  net ${r.totalPnL.toFixed(2)}  (end ${r.balance.toFixed(2)}, ` +
        `fees ${r.totalFees.toFixed(2)}, taker ${pct(f.takerRate)})`
    );
    vipComparison.push({
      vip,
      net: r.totalPnL,
      end: r.balance,
      fees: r.totalFees,
      takerRate: f.takerRate,
      makerRate: f.makerRate,
    });
    curves.push({ label: `vip ${vip}`, startBalance: r.startBalance, finalBalance: r.balance, equity: r.equity });
  }
  const cmpSvg = ChartExport.equityComparisonSvg(curves, {
    title: `Zone Recovery — ${symbol} fee-tier comparison (best setting)`,
    subtitle: `${settingsTag.replace(/ · vip \d+/, "")}  ·  equity per fee tier vip 0..9`,
    note: `${quote} margin · ${bnbTag}`,
  });
  fs.writeFileSync(path.join(outDir, "vip-fee-comparison.svg"), cmpSvg);
  fs.writeFileSync(path.join(outTop, "vip-fee-comparison.svg"), cmpSvg);

  // ---- Machine-readable summary -------------------------------------------
  const summary = {
    generatedAt: new Date().toISOString(),
    market: symbol,
    coin,
    data: {
      source: label,
      files: csvs.map((f) => path.basename(f)),
      ticks: ticks.length,
      firstTime,
      lastTime,
      firstDate: firstTime != null ? new Date(firstTime).toISOString() : null,
      lastDate: lastTime != null ? new Date(lastTime).toISOString() : null,
      days,
    },
    bracket: { leverage: lev, maxNotional, maxPositionQty, coin },
    fees: {
      quote, // margin/quote asset → fee table, derived from the symbol
      bnbDiscount,
      vipLevel: o.vipLevel,
      makerRate: bestFee.makerRate,
      takerRate: bestFee.takerRate,
      // Same tier on the other quote, for the USDC-vs-USDT contrast.
      altQuote: otherQuote,
      altMakerRate: otherFee.makerRate,
      altTakerRate: otherFee.takerRate,
    },
    best: {
      id: bestId,
      setting: {
        leverage: lev,
        ratio: o.ratio,
        gapPercent: o.gapPercent,
        maxSteps: o.maxSteps,
        maxDrawdownPercent: o.maxDrawdownPercent,
        side: bestSide,
        vipLevel: o.vipLevel,
      },
      startBalance: b.result.startBalance,
      endBalance: b.result.balance,
      netPnL: b.result.totalPnL,
      gross: b.result.grossProfit,
      fees: b.result.totalFees,
      series: b.result.seriesCount,
      winRate: b.result.winRate,
      maxStep: b.result.maxStepReached,
      maxDrawdown: b.result.maxDrawdown,
      tradeVolume: volume,
      tradeVolumePerDay: volumePerDay,
    },
    vipComparison,
    allResults,
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\nWritten to: ${outDir}`);
  console.log(`  best-pnl.svg · vip-fee-comparison.svg · trades.csv · summary.json`);
  console.log(`Latest copies: ${path.join(outTop, "best-pnl.svg")} · ${path.join(outTop, "vip-fee-comparison.svg")}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
