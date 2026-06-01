import { describe, expect, test } from "@jest/globals";
import { Matrix, Backtester, PriceLoader } from "../src";

describe("Matrix — parameter sweep", () => {
  test("expand turns a range into discrete values", () => {
    expect(Matrix.expand({ key: "ratio", start: 2, end: 4, step: 0.5 })).toEqual([
      2, 2.5, 3, 3.5, 4,
    ]);
    expect(Matrix.expand({ key: "maxSteps", start: 4, end: 8, step: 2 })).toEqual([
      4, 6, 8,
    ]);
  });

  test("fromRanges produces the full cartesian product", () => {
    const combos = Matrix.fromRanges([
      { key: "leverage", start: 50, end: 100, step: 25 }, // 3
      { key: "ratio", start: 2, end: 3, step: 1 }, // 2
    ]);
    expect(combos.length).toBe(6); // 3 × 2
    expect(combos[0]).toEqual({ leverage: 50, ratio: 2 });
    // Every combination is present and unique.
    const keys = combos.map((c) => `${c.leverage}-${c.ratio}`);
    expect(new Set(keys).size).toBe(6);
  });

  test("a matrix run executes every combination and each obeys the invariant", () => {
    const combos = Matrix.fromRanges([
      { key: "leverage", start: 50, end: 100, step: 50 }, // 50, 100
      { key: "ratio", start: 2, end: 3, step: 1 }, // 2, 3
    ]);

    // Oscillating ticks so several recovery series form and resolve.
    const path: number[] = [];
    for (let k = 0; k < 40; k++) path.push(10000, 10100, 9900, 10200, 9800);
    const ticks = PriceLoader.syntheticTicks(path);

    const results = combos.map((combo) =>
      new Backtester().run(
        {
          symbol: "BTC/USDT",
          ratio: combo.ratio,
          leverage: combo.leverage,
          gapPercent: 30,
          baseQuantity: 0.001,
          maxSteps: 6,
          forceSide: "buy",
          startBalance: 1000,
        },
        ticks
      )
    );

    expect(results.length).toBe(combos.length);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      expect(Number.isFinite(r.totalPnL)).toBe(true);
      // Accounting identity holds for every combination.
      expect(r.totalPnL).toBeCloseTo(r.grossProfit - r.totalFees, 6);
      // Each completed series hits its designed target (per-series gap).
      const firstBySeries = new Map<string | number, (typeof r.orders)[number]>();
      for (const o of r.orders)
        if (!firstBySeries.has(o.seriesId!)) firstBySeries.set(o.seriesId!, o);
      const M = 1 + 1 / combos[i].ratio;
      for (const s of r.series) {
        const gap = Math.abs(
          firstBySeries.get(s.seriesId)!.price -
            firstBySeries.get(s.seriesId)!.stopLoss!
        );
        const target =
          s.outcome === "win"
            ? combos[i].ratio * gap * 0.001
            : -gap * 0.001 * ((Math.pow(M, s.steps) - 1) / (M - 1));
        expect(s.grossProfit).toBeCloseTo(target, 8);
      }
    }
  });
});
