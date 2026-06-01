import { describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { Backtester, PriceLoader } from "../src";

// ===========================================================================
// Backtester — deterministic synthetic series
// ===========================================================================
describe("Backtester — synthetic price path", () => {
  test("a 3-step series resolves to the constant gross target", () => {
    const ratio = 2;
    const leverage = 100;
    const gapPercent = 30; // (30/100/100)·10000 = 30 price gap
    const gap = 30;
    const baseQuantity = 0.001;
    const expectedGross = ratio * gap * baseQuantity; // 0.06

    // long@10000 → SL 9970 → short@9970 → SL 10000 → long@10000 → TP 10060
    const ticks = PriceLoader.syntheticTicks([10000, 9970, 10000, 10060]);

    const bt = new Backtester();
    const result = bt.run(
      {
        symbol: "BTC/USDT",
        ratio,
        leverage,
        gapPercent,
        baseQuantity,
        maxSteps: 5,
        forceSide: "buy",
        startBalance: 1000,
      },
      ticks
    );

    expect(result.seriesCount).toBe(1);
    expect(result.series[0].outcome).toBe("win");
    expect(result.series[0].steps).toBe(3);
    expect(result.series[0].grossProfit).toBeCloseTo(expectedGross, 9);
    expect(result.maxStepReached).toBe(3);

    // Balance accounting ties out: net = gross − fees, booked to the balance.
    expect(result.grossProfit).toBeCloseTo(expectedGross, 9);
    expect(result.totalPnL).toBeCloseTo(result.grossProfit - result.totalFees, 9);
    expect(result.balance).toBeCloseTo(1000 + result.totalPnL, 9);
  });

  test("a single tick that gaps past the take-profit still books one win", () => {
    // Price jumps straight through the TP at 10060.
    const ticks = PriceLoader.syntheticTicks([10000, 12000]);
    const bt = new Backtester();
    const result = bt.run(
      {
        symbol: "BTC/USDT",
        ratio: 2,
        leverage: 100,
        gapPercent: 30,
        baseQuantity: 0.001,
        maxSteps: 5,
        forceSide: "buy",
      },
      ticks
    );
    expect(result.series[0].outcome).toBe("win");
    // Closed at the TP line (10060), not the overshoot price → exact target.
    expect(result.series[0].grossProfit).toBeCloseTo(0.06, 9);
  });

  test("drawdown sizing keeps the balance positive on a fully-lost series", () => {
    // Oscillate exactly between the two zone lines (10000 / 9940, gap = 60 at
    // 50× / 30%) so every hedge stop-loss fires until maxSteps is reached.
    const ticks = PriceLoader.syntheticTicks([10000, 9940, 10000, 9940, 10000]);
    const bt = new Backtester();
    const result = bt.run(
      {
        symbol: "BTC/USDT",
        ratio: 2,
        leverage: 50,
        gapPercent: 30,
        maxDrawdownPercent: 40,
        maxSteps: 4,
        forceSide: "buy",
        startBalance: 1000,
      },
      ticks
    );

    expect(result.series[0].outcome).toBe("loss");
    // The worst case loses exactly 40% of the balance — never more.
    expect(result.series[0].grossProfit).toBeCloseTo(-400, 6);
    expect(result.balance).toBeCloseTo(1000 - 400 - result.totalFees, 6);
    expect(result.balance).toBeGreaterThan(0);
    for (const p of result.equity) expect(p.balance).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Backtester — real Binance tick data
// ===========================================================================
const TICK_CSV = path.resolve(
  __dirname,
  "../data/BTC/BTCUSDT-trades-2023-02-25.csv"
);

describe("Backtester — real tick data", () => {
  const hasData = fs.existsSync(TICK_CSV);

  (hasData ? test : test.skip)(
    "every series nets its designed target (recovery covers all hedge trades)",
    () => {
      const ratio = 2;
      const leverage = 100;
      const gapPercent = 20; // "20% SL" (margin terms); TP = ratio × that = 40%
      const baseQuantity = 0.001;
      const maxSteps = 6;
      const M = 1 + 1 / ratio;

      // Read a slice — the file is ~2.4M ticks; 500k spans enough movement for
      // series to complete at this gap (0.20% price gap, 0.40% TP at 100×).
      const ticks = PriceLoader.loadTicks(TICK_CSV, 500_000);
      expect(ticks.length).toBeGreaterThan(100);

      const bt = new Backtester();
      const result = bt.run(
        {
          symbol: "BTC/USDT",
          ratio,
          leverage,
          gapPercent,
          baseQuantity,
          maxSteps,
          forceSide: "buy",
          startBalance: 1000,
          lossTakingPolicy: "take-loss",
        },
        ticks
      );

      expect(result.seriesCount).toBeGreaterThan(0);

      // With a percentage gap the absolute target scales with each series' entry
      // price, so derive each series' gap from its first order's stop-loss
      // distance. The headline property still holds: every completed series nets
      // exactly its designed target regardless of how many recovery steps it took.
      const firstOrderBySeries = new Map<string | number, (typeof result.orders)[number]>();
      for (const o of result.orders) {
        if (!firstOrderBySeries.has(o.seriesId!)) firstOrderBySeries.set(o.seriesId!, o);
      }

      for (const s of result.series) {
        const first = firstOrderBySeries.get(s.seriesId)!;
        const gap = Math.abs(first.price - first.stopLoss!);
        if (s.outcome === "win") {
          expect(s.grossProfit).toBeCloseTo(ratio * gap * baseQuantity, 8);
        } else {
          expect(s.steps).toBe(maxSteps);
          const lossTarget =
            -gap * baseQuantity * ((Math.pow(M, maxSteps) - 1) / (M - 1));
          expect(s.grossProfit).toBeCloseTo(lossTarget, 8);
        }
      }

      // Aggregate accounting identity: net = gross − fees, booked to the balance.
      expect(result.totalPnL).toBeCloseTo(result.grossProfit - result.totalFees, 6);

      // Completed series reconcile against the realized (closed-order) totals,
      // aside from the legs of the series still open when the ticks ran out.
      const sumNet = result.series.reduce((a, s) => a + s.netProfit, 0);
      const openSeriesNet = result.orders
        .filter((o) => o.status === "closed" && o.seriesId === result.seriesCount)
        .reduce((a, o) => a + o.pnl, 0);
      expect(result.totalPnL).toBeCloseTo(sumNet + openSeriesNet, 6);
    },
    30_000
  );
});
