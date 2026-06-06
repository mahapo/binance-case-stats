import { describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChartExport, EquitySeries } from "../src";

const series = (final: number): EquitySeries => ({
  startBalance: 1000,
  finalBalance: final,
  equity: [
    { time: 1_700_000_000_000, balance: 1010 },
    { time: 1_700_000_500_000, balance: 980 },
    { time: 1_700_001_000_000, balance: final },
  ],
});

describe("ChartExport — equity/PnL SVG", () => {
  test("produces a valid SVG with the curve and PnL stat", () => {
    const svg = ChartExport.equitySvg(series(1200), {
      title: "Test",
      subtitle: "lev 100",
    });
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("Test");
    expect(svg).toContain("+200"); // PnL = 1200 − 1000
    expect(svg).toContain("+20.00%");
  });

  test("colours the curve green for profit, red for loss", () => {
    expect(ChartExport.equitySvg(series(1200))).toContain("#16a34a"); // green
    expect(ChartExport.equitySvg(series(800))).toContain("#dc2626"); // red
  });

  test("overlays a price series on a secondary axis when provided", () => {
    const price = Array.from({ length: 50 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 10_000,
      price: 100 + i,
    }));
    const svg = ChartExport.equitySvg(series(1200), { priceSeries: price });
    expect((svg.match(/<polyline/g) || []).length).toBe(2); // equity + price
    expect(svg).toContain("#d97706"); // amber price line + right axis
    expect(svg).toContain(">price</text>");
    expect(svg).toContain(">equity</text>");
    expect(svg).not.toMatch(/NaN|Infinity/);
    // No overlay → still a single polyline.
    expect((ChartExport.equitySvg(series(1200)).match(/<polyline/g) || []).length).toBe(1);
  });

  test("handles an empty equity curve (flat at start balance)", () => {
    const svg = ChartExport.equitySvg({
      startBalance: 1000,
      finalBalance: 1000,
      equity: [],
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<polyline");
  });

  test("equityComparisonSvg overlays multiple curves with a legend", () => {
    const svg = ChartExport.equityComparisonSvg(
      [
        { label: "vip 0", startBalance: 1000, finalBalance: 900, equity: series(900).equity },
        { label: "vip 9", startBalance: 1000, finalBalance: 1300, equity: series(1300).equity },
      ],
      { title: "Fee comparison" }
    );
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("Fee comparison");
    expect(svg).toContain("vip 0");
    expect(svg).toContain("vip 9");
    // One polyline per curve (at least 2).
    expect((svg.match(/<polyline/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test("handles huge equity curves without stack overflow and stays small", () => {
    const equity = Array.from({ length: 250_000 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 1000,
      balance: 1000 + Math.sin(i / 1000) * 500,
    }));
    const big = { startBalance: 1000, finalBalance: 1400, equity };
    const single = ChartExport.equitySvg(big);
    expect(single).toContain("<polyline");
    const cmp = ChartExport.equityComparisonSvg([
      { label: "a", ...big },
      { label: "b", ...big },
    ]);
    expect(cmp).toContain("<polyline");
    // Downsampled → the point count (commas in polylines) is bounded.
    expect((cmp.match(/,/g) || []).length).toBeLessThan(20_000);
  });

  test("tradesSvg draws price, entries, lots and per-series PnL", () => {
    const ticks = Array.from({ length: 200 }, (_, i) => ({
      time: 1_700_000_000_000 + i * 1000,
      price: 100 + Math.sin(i / 20) * 2,
    }));
    const svg = ChartExport.tradesSvg({
      ticks,
      series: [
        {
          seriesId: 0,
          outcome: "win",
          grossProfit: 5,
          netProfit: 4.2,
          orders: [
            { step: 1, side: "buy", entry: 100, stopLoss: 99, takeProfit: 102, quantity: 0.01, pnl: -1, fillTime: ticks[10].time, exitTime: ticks[30].time, exitPrice: 99, hit: "sl" },
            { step: 2, side: "sell", entry: 99, stopLoss: 100, takeProfit: 97, quantity: 0.02, pnl: 5, fillTime: ticks[30].time, exitTime: ticks[60].time, exitPrice: 97, hit: "tp" },
          ],
        },
      ],
      title: "How it works",
    });
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("How it works");
    expect(svg).toContain("<polyline"); // price line + zigzag
    expect(svg).toContain("<circle"); // numbered entries
    expect(svg).toContain("Series 0");
    expect(svg).toContain("L 0.0100"); // lot label for step 1
  });

  test("barChartSvg anchors at zero and colours by sign", () => {
    const svg = ChartExport.barChartSvg(
      [
        { label: "vip 0", value: -68.27 },
        { label: "vip 9", value: 50.31 },
      ],
      { title: "Net PnL per fee tier", valueSuffix: " USDT" }
    );
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("Net PnL per fee tier");
    expect(svg).toContain("#dc2626"); // negative bar red
    expect(svg).toContain("#16a34a"); // positive bar green
    expect(svg).toContain("vip 0");
    expect(svg).toContain("-68.27 USDT");
    expect(svg).toContain("+50.31 USDT");
  });

  test("equity chart y-axis starts at 0", () => {
    const svg = ChartExport.equitySvg(series(1500));
    // The bottom gridline label is 0, and no axis label is negative.
    expect(svg).toContain(">0.00</text>");
    expect(svg).not.toMatch(/>-\d/);
  });

  test("comparison accepts a custom legend", () => {
    const svg = ChartExport.equityComparisonSvg(
      [
        { label: "s1", startBalance: 1000, finalBalance: 900, equity: series(900).equity },
        { label: "s2", startBalance: 1000, finalBalance: 1300, equity: series(1300).equity },
      ],
      { legendItems: [{ label: "Regular", color: "#dc2626" }, { label: "VIP", color: "#16a34a" }] }
    );
    expect(svg).toContain("Regular");
    expect(svg).toContain("VIP");
    expect(svg).not.toContain("s1"); // per-curve legend suppressed
  });

  test("recoverySchematicSvg draws the staircase, zone lines and TP corridor", () => {
    const svg = ChartExport.recoverySchematicSvg({
      seriesId: 7,
      outcome: "win",
      grossProfit: 5,
      netProfit: 4.2,
      orders: [
        { step: 1, side: "buy", entry: 100, stopLoss: 99, takeProfit: 103, quantity: 0.01, pnl: -1, fillTime: 0, exitTime: 0, exitPrice: 99, hit: "sl" },
        { step: 2, side: "sell", entry: 99, stopLoss: 100, takeProfit: 96, quantity: 0.02, pnl: -1, fillTime: 0, exitTime: 0, exitPrice: 100, hit: "sl" },
        { step: 3, side: "buy", entry: 100, stopLoss: 99, takeProfit: 103, quantity: 0.04, pnl: 5, fillTime: 0, exitTime: 0, exitPrice: 103, hit: "tp" },
      ],
    });
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("Take-Profit");
    expect(svg).toContain("Series 7");
    expect(svg).toContain("Long 0.0100");
    expect(svg).toContain("Short 0.0200");
    expect((svg.match(/<circle/g) || []).length).toBeGreaterThanOrEqual(3); // numbered entries
  });

  test("logScale comparison renders without error", () => {
    const big = (final: number): EquitySeries => ({
      startBalance: 10000,
      finalBalance: final,
      equity: [
        { time: 1, balance: 10000 },
        { time: 2, balance: final },
      ],
    });
    const svg = ChartExport.equityComparisonSvg(
      [
        { label: "ruin", ...big(0.01) },
        { label: "rich", ...big(3_000_000) },
      ],
      { logScale: true }
    );
    expect(svg).toContain("<polyline");
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  test("writeEquitySvg writes a file and creates parent dirs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-"));
    const file = path.join(dir, "nested", "pnl.svg");
    const out = ChartExport.writeEquitySvg(series(1500), file, { title: "X" });
    expect(out).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8").startsWith("<?xml")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
