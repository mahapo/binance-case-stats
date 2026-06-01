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

  test("handles an empty equity curve (flat at start balance)", () => {
    const svg = ChartExport.equitySvg({
      startBalance: 1000,
      finalBalance: 1000,
      equity: [],
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<polyline");
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
