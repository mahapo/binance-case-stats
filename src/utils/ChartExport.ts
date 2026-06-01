import * as fs from "fs";
import * as path from "path";

// Dependency-free PnL/equity chart export as a self-contained SVG (opens in any
// browser or IDE). Plots the running balance (= start balance + cumulative PnL)
// over time, with the start-balance baseline marked.

export interface EquityPoint {
  time: number; // ms
  balance: number;
}

export interface EquitySeries {
  startBalance: number;
  finalBalance: number;
  equity: EquityPoint[];
}

export interface ChartOptions {
  width?: number;
  height?: number;
  title?: string;
  subtitle?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class ChartExport {
  /** Build an SVG string of the equity/PnL curve. */
  static equitySvg(series: EquitySeries, options: ChartOptions = {}): string {
    const W = options.width ?? 1000;
    const H = options.height ?? 520;
    const m = { top: 64, right: 32, bottom: 52, left: 78 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    // Always begin the curve at the start balance.
    const pts: EquityPoint[] =
      series.equity.length > 0
        ? [{ time: series.equity[0].time, balance: series.startBalance }, ...series.equity]
        : [{ time: 0, balance: series.startBalance }];

    const times = pts.map((p) => p.time);
    const bals = pts.map((p) => p.balance);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    let yMin = Math.min(series.startBalance, ...bals);
    let yMax = Math.max(series.startBalance, ...bals);
    const pad = (yMax - yMin) * 0.08 || Math.max(1, yMax * 0.05);
    yMin -= pad;
    yMax += pad;

    const x = (t: number) =>
      m.left + (tMax === tMin ? pw / 2 : ((t - tMin) / (tMax - tMin)) * pw);
    const y = (b: number) =>
      m.top + (yMax === yMin ? ph / 2 : (1 - (b - yMin) / (yMax - yMin)) * ph);

    const up = series.finalBalance >= series.startBalance;
    const lineColor = up ? "#16a34a" : "#dc2626";

    // Horizontal gridlines + y labels.
    const yTicks = 5;
    let grid = "";
    for (let i = 0; i <= yTicks; i++) {
      const bal = yMin + ((yMax - yMin) * i) / yTicks;
      const yy = y(bal);
      grid +=
        `<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}" ` +
        `stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${m.left - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end" ` +
        `font-size="12" fill="#6b7280">${fmt(bal)}</text>`;
    }

    // Start-balance baseline.
    const yBase = y(series.startBalance);
    const baseline =
      `<line x1="${m.left}" y1="${yBase.toFixed(1)}" x2="${m.left + pw}" y2="${yBase.toFixed(1)}" ` +
      `stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="6 4"/>` +
      `<text x="${m.left + pw}" y="${(yBase - 6).toFixed(1)}" text-anchor="end" ` +
      `font-size="11" fill="#6b7280">start ${fmt(series.startBalance)}</text>`;

    // X labels (start / end date).
    const xLabels =
      `<text x="${m.left}" y="${H - 18}" text-anchor="start" font-size="12" fill="#6b7280">${day(tMin)}</text>` +
      `<text x="${m.left + pw}" y="${H - 18}" text-anchor="end" font-size="12" fill="#6b7280">${day(tMax)}</text>`;

    // The equity polyline + area fill.
    const poly = pts.map((p) => `${x(p.time).toFixed(1)},${y(p.balance).toFixed(1)}`).join(" ");
    const area =
      `${m.left},${(m.top + ph).toFixed(1)} ` +
      poly +
      ` ${(m.left + pw).toFixed(1)},${(m.top + ph).toFixed(1)}`;

    const pnl = series.finalBalance - series.startBalance;
    const pnlPct = (pnl / series.startBalance) * 100;
    const title = esc(options.title ?? "Equity / PnL");
    const subtitle = esc(options.subtitle ?? "");
    const stat =
      `${up ? "+" : ""}${fmt(pnl)} USDT  (${up ? "+" : ""}${pnlPct.toFixed(2)}%)`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${m.left}" y="28" font-size="18" font-weight="700" fill="#111827">${title}</text>
  <text x="${m.left}" y="48" font-size="12.5" fill="#6b7280">${subtitle}</text>
  <text x="${W - m.right}" y="28" text-anchor="end" font-size="18" font-weight="700" fill="${lineColor}">${stat}</text>
  ${grid}
  ${baseline}
  <polygon points="${area}" fill="${lineColor}" fill-opacity="0.08"/>
  <polyline points="${poly}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round"/>
  ${xLabels}
</svg>
`;
  }

  /** Write the equity/PnL SVG to disk, creating parent dirs as needed. */
  static writeEquitySvg(
    series: EquitySeries,
    filePath: string,
    options: ChartOptions = {}
  ): string {
    const svg = ChartExport.equitySvg(series, options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg);
    return filePath;
  }
}
