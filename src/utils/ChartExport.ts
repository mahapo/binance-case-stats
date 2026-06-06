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
  /** Right-aligned highlight on the subtitle line (e.g. the fee config). */
  note?: string;
  /** Override the auto legend (e.g. when overlaying many same-group curves). */
  legendItems?: { label: string; color: string }[];
  /** Use a logarithmic balance axis (for $0 → millions divergence). */
  logScale?: boolean;
  /** Optional price series overlaid on a secondary (right) axis. */
  priceSeries?: PricePoint[];
}

export interface EquityCurve {
  label: string;
  startBalance: number;
  finalBalance: number;
  equity: EquityPoint[];
  color?: string;
}

// Distinct palette for overlaying up to ~10 curves.
const PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#475569", "#ea580c",
];

export interface PricePoint {
  time: number;
  price: number;
}

export interface VizOrder {
  step: number; // 1-based step in the series
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  pnl: number;
  fillTime: number;
  exitTime: number;
  exitPrice: number;
  hit: "tp" | "sl" | "open";
}

export interface VizSeries {
  seriesId: number | string;
  outcome: "win" | "loss" | "open";
  grossProfit: number;
  netProfit: number;
  orders: VizOrder[];
}

export interface TradesChartInput {
  ticks: PricePoint[];
  series: VizSeries[];
  title?: string;
  subtitle?: string;
  width?: number;
  height?: number;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Loop-based min/max — `Math.min(...arr)` overflows the stack on large arrays.
const minOf = (arr: number[]): number => {
  let m = Infinity;
  for (const v of arr) if (v < m) m = v;
  return m;
};
const maxOf = (arr: number[]): number => {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
};

// Cap the number of plotted points so the SVG stays small for huge curves.
const downsample = <T>(pts: T[], max = 3000): T[] => {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  const out: T[] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
};

export class ChartExport {
  /** Build an SVG string of the equity/PnL curve. */
  static equitySvg(series: EquitySeries, options: ChartOptions = {}): string {
    const W = options.width ?? 1000;
    const H = options.height ?? 520;
    // Optional price overlay → reserve a right margin for its secondary axis.
    const priceAll = options.priceSeries ?? [];
    const hasPrice = priceAll.length > 0;
    // A fee note gets its own line under the subtitle → taller header.
    const m = { top: options.note ? 88 : 64, right: hasPrice ? 66 : 32, bottom: 52, left: 78 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    // Always begin the curve at the start balance.
    const pts: EquityPoint[] =
      series.equity.length > 0
        ? [{ time: series.equity[0].time, balance: series.startBalance }, ...series.equity]
        : [{ time: 0, balance: series.startBalance }];

    const times = pts.map((p) => p.time);
    const bals = pts.map((p) => p.balance);
    // Share the x-axis across equity + price so they line up on the same window.
    const ptimes = priceAll.map((p) => p.time);
    const tMin = Math.min(minOf(times), hasPrice ? minOf(ptimes) : Infinity);
    const tMax = Math.max(maxOf(times), hasPrice ? maxOf(ptimes) : -Infinity);
    // Balances are never negative — anchor the axis at 0 so the magnitude is honest.
    let yMin = 0;
    let yMax = Math.max(series.startBalance, maxOf(bals));
    yMax += yMax * 0.08 || 1;

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

    // The equity polyline + area fill (downsampled for huge curves).
    const poly = downsample(pts)
      .map((p) => `${x(p.time).toFixed(1)},${y(p.balance).toFixed(1)}`)
      .join(" ");
    const area =
      `${x(pts[0].time).toFixed(1)},${(m.top + ph).toFixed(1)} ` +
      poly +
      ` ${x(pts[pts.length - 1].time).toFixed(1)},${(m.top + ph).toFixed(1)}`;

    // Optional price overlay on its own right-hand axis (drawn behind equity).
    let priceLayer = "";
    let priceLegend = "";
    if (hasPrice) {
      const prices = priceAll.map((p) => p.price);
      let pMin = minOf(prices);
      let pMax = maxOf(prices);
      const padP = (pMax - pMin) * 0.08 || Math.abs(pMax) * 0.01 || 1;
      pMin -= padP;
      pMax += padP;
      const py = (p: number) =>
        m.top + (pMax === pMin ? ph / 2 : (1 - (p - pMin) / (pMax - pMin)) * ph);
      const ppoly = downsample(priceAll)
        .map((p) => `${x(p.time).toFixed(1)},${py(p.price).toFixed(1)}`)
        .join(" ");
      let pAxis = "";
      for (let i = 0; i <= 5; i++) {
        const pv = pMin + ((pMax - pMin) * i) / 5;
        pAxis +=
          `<text x="${m.left + pw + 8}" y="${(py(pv) + 4).toFixed(1)}" text-anchor="start" ` +
          `font-size="11" fill="#d97706">${fmt(pv)}</text>`;
      }
      priceLayer =
        `<polyline points="${ppoly}" fill="none" stroke="#d97706" stroke-width="1.2" ` +
        `stroke-linejoin="round" opacity="0.6"/>` +
        pAxis +
        `<text x="${m.left + pw + 8}" y="${(m.top - 8).toFixed(1)}" text-anchor="start" ` +
        `font-size="11" font-weight="600" fill="#d97706">price</text>`;
      // Small legend so the two lines are unambiguous.
      const lgY = m.top + 14;
      priceLegend =
        `<line x1="${m.left + 10}" y1="${lgY}" x2="${m.left + 32}" y2="${lgY}" stroke="${lineColor}" stroke-width="2.5"/>` +
        `<text x="${m.left + 38}" y="${lgY + 4}" font-size="11.5" fill="#374151">equity</text>` +
        `<line x1="${m.left + 10}" y1="${lgY + 16}" x2="${m.left + 32}" y2="${lgY + 16}" stroke="#d97706" stroke-width="2.5" opacity="0.8"/>` +
        `<text x="${m.left + 38}" y="${lgY + 20}" font-size="11.5" fill="#374151">price</text>`;
    }

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
  ${options.note ? `<text x="${m.left}" y="68" font-size="12.5" font-weight="600" fill="#1d4ed8">${esc(options.note)}</text>` : ""}
  <text x="${W - m.right}" y="28" text-anchor="end" font-size="18" font-weight="700" fill="${lineColor}">${stat}</text>
  ${grid}
  ${baseline}
  ${priceLayer}
  <polygon points="${area}" fill="${lineColor}" fill-opacity="0.08"/>
  <polyline points="${poly}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round"/>
  ${priceLegend}
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

  /** Overlay several equity curves on shared axes, with a legend. */
  static equityComparisonSvg(
    curves: EquityCurve[],
    options: ChartOptions = {}
  ): string {
    const W = options.width ?? 1100;
    const H = options.height ?? 560;
    const m = { top: options.note ? 88 : 64, right: 168, bottom: 52, left: 80 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    const startBalance = curves[0]?.startBalance ?? 0;
    const withStart = (c: EquityCurve): EquityPoint[] =>
      c.equity.length > 0
        ? [{ time: c.equity[0].time, balance: c.startBalance }, ...c.equity]
        : [{ time: 0, balance: c.startBalance }];

    const allPts = curves.flatMap(withStart);
    const times = allPts.map((p) => p.time);
    const bals = allPts.map((p) => p.balance);
    const tMin = minOf(times);
    const tMax = maxOf(times);

    // Linear axis anchors at 0; log axis spans a $0→millions divergence (balances
    // are floored to a small positive value so wiped-out curves stay on-chart).
    const log = options.logScale ?? false;
    const floor = Math.max(1, startBalance * 1e-3);
    const tf = (b: number) => (log ? Math.log10(Math.max(b, floor)) : b);
    let yMin = log ? tf(floor) : 0;
    let yMax = tf(Math.max(startBalance, maxOf(bals)));
    yMax += log ? 0.04 * (yMax - yMin) || 0.2 : yMax * 0.08 || 1;

    const x = (t: number) =>
      m.left + (tMax === tMin ? pw / 2 : ((t - tMin) / (tMax - tMin)) * pw);
    const y = (b: number) =>
      m.top + (yMax === yMin ? ph / 2 : (1 - (tf(b) - yMin) / (yMax - yMin)) * ph);

    let grid = "";
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const vPos = yMin + ((yMax - yMin) * i) / yTicks;
      const bal = log ? Math.pow(10, vPos) : vPos;
      const yy = m.top + (1 - i / yTicks) * ph;
      grid +=
        `<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${m.left - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#6b7280">${fmt(bal)}</text>`;
    }

    const yBase = y(startBalance);
    const baseline = `<line x1="${m.left}" y1="${yBase.toFixed(1)}" x2="${m.left + pw}" y2="${yBase.toFixed(1)}" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="6 4"/>`;

    const lines = curves
      .map((c, i) => {
        const color = c.color ?? PALETTE[i % PALETTE.length];
        const poly = downsample(withStart(c))
          .map((p) => `${x(p.time).toFixed(1)},${y(p.balance).toFixed(1)}`)
          .join(" ");
        return `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" opacity="0.9"/>`;
      })
      .join("\n  ");

    // Legend (right panel). A custom legend keeps it readable when overlaying
    // many same-group curves; otherwise list each curve sorted best → worst.
    const legendX = m.left + pw + 18;
    const legendRows = options.legendItems
      ? options.legendItems.map((it) => ({ label: it.label, color: it.color }))
      : curves
          .map((c, i) => ({ c, color: c.color ?? PALETTE[i % PALETTE.length] }))
          .sort((a, b) => b.c.finalBalance - a.c.finalBalance)
          .map((e) => ({
            label: `${e.c.label}  ${fmt(e.c.finalBalance)}`,
            color: e.color,
          }));
    const legend = legendRows
      .map((e, row) => {
        const yy = m.top + 6 + row * 22;
        return (
          `<line x1="${legendX}" y1="${yy}" x2="${legendX + 22}" y2="${yy}" stroke="${e.color}" stroke-width="3"/>` +
          `<text x="${legendX + 30}" y="${yy + 4}" font-size="12.5" fill="#374151">${esc(e.label)}</text>`
        );
      })
      .join("\n  ");

    const xLabels =
      `<text x="${m.left}" y="${H - 18}" text-anchor="start" font-size="12" fill="#6b7280">${day(tMin)}</text>` +
      `<text x="${m.left + pw}" y="${H - 18}" text-anchor="end" font-size="12" fill="#6b7280">${day(tMax)}</text>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${m.left}" y="28" font-size="18" font-weight="700" fill="#111827">${esc(options.title ?? "Equity comparison")}</text>
  <text x="${m.left}" y="48" font-size="12.5" fill="#6b7280">${esc(options.subtitle ?? "")}</text>
  ${options.note ? `<text x="${m.left}" y="68" font-size="12.5" font-weight="600" fill="#1d4ed8">${esc(options.note)}</text>` : ""}
  ${grid}
  ${baseline}
  ${lines}
  ${legend}
  ${xLabels}
</svg>
`;
  }

  /** Write the multi-curve comparison SVG to disk. */
  static writeEquityComparisonSvg(
    curves: EquityCurve[],
    filePath: string,
    options: ChartOptions = {}
  ): string {
    const svg = ChartExport.equityComparisonSvg(curves, options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg);
    return filePath;
  }

  /**
   * Illustrative "how the bot works" chart: the real price in the background
   * with each recovery series drawn on top — the gap zone, the take-profit
   * envelope, numbered entries with their lot size, the SL/TP each leg targets,
   * where it exited, and the series PnL. Mirrors the CAP Zone Recovery diagram.
   */
  static tradesSvg(input: TradesChartInput): string {
    const W = input.width ?? 1180;
    const H = input.height ?? 640;
    const m = { top: 60, right: 214, bottom: 46, left: 72 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    const ticks = input.ticks.length
      ? input.ticks
      : [{ time: 0, price: 0 }];
    const allOrders = input.series.flatMap((s) => s.orders);

    const times = ticks.map((p) => p.time);
    const tMin = minOf(times);
    const tMax = maxOf(times);
    // Zoom to the TRADE region (entries / SL / TP), not the full price excursion,
    // so the zones and the recovery staircase are visible. The price line is
    // clipped to this window (it shows local context, not a squashed full range).
    const lvls = allOrders.flatMap((o) => [o.entry, o.stopLoss, o.takeProfit, o.exitPrice]);
    let yMin = minOf(lvls);
    let yMax = maxOf(lvls);
    const pad = (yMax - yMin) * 0.12 || 1;
    yMin -= pad;
    yMax += pad;

    const x = (t: number) =>
      m.left + (tMax === tMin ? pw / 2 : ((t - tMin) / (tMax - tMin)) * pw);
    const y = (p: number) =>
      m.top + (yMax === yMin ? ph / 2 : (1 - (p - yMin) / (yMax - yMin)) * ph);
    const clampX = (t: number) => Math.max(m.left, Math.min(m.left + pw, x(t)));

    // y gridlines + price labels.
    let grid = "";
    for (let i = 0; i <= 5; i++) {
      const p = yMin + ((yMax - yMin) * i) / 5;
      const yy = y(p);
      grid +=
        `<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>` +
        `<text x="${m.left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#94a3b8">${fmt(p)}</text>`;
    }

    // Background price line.
    const priceLine = downsample(ticks)
      .map((p) => `${x(p.time).toFixed(1)},${y(p.price).toFixed(1)}`)
      .join(" ");

    const buyColor = "#16a34a";
    const sellColor = "#dc2626";
    let layers = "";
    let panel = "";

    input.series.forEach((s, si) => {
      const color = s.orders[0]?.side === "sell" ? sellColor : PALETTE[si % PALETTE.length];
      const entries = s.orders.map((o) => o.entry);
      const A = maxOf(entries); // upper zone line
      const B = minOf(entries); // lower zone line
      const topTP = maxOf(s.orders.map((o) => o.takeProfit));
      const botTP = minOf(s.orders.map((o) => o.takeProfit));
      const t0 = clampX(minOf(s.orders.map((o) => o.fillTime)));
      const t1 = clampX(maxOf(s.orders.map((o) => o.exitTime)));

      // Recovery-gap band + zone lines + TP envelope.
      layers +=
        `<rect x="${t0.toFixed(1)}" y="${y(A).toFixed(1)}" width="${(t1 - t0).toFixed(1)}" height="${(y(B) - y(A)).toFixed(1)}" fill="#64748b" fill-opacity="0.08"/>` +
        `<line x1="${t0.toFixed(1)}" y1="${y(A).toFixed(1)}" x2="${t1.toFixed(1)}" y2="${y(A).toFixed(1)}" stroke="#2563eb" stroke-width="1"/>` +
        `<line x1="${t0.toFixed(1)}" y1="${y(B).toFixed(1)}" x2="${t1.toFixed(1)}" y2="${y(B).toFixed(1)}" stroke="#dc2626" stroke-width="1"/>` +
        `<line x1="${t0.toFixed(1)}" y1="${y(topTP).toFixed(1)}" x2="${t1.toFixed(1)}" y2="${y(topTP).toFixed(1)}" stroke="#16a34a" stroke-width="1.3" stroke-dasharray="7 4"/>` +
        `<line x1="${t0.toFixed(1)}" y1="${y(botTP).toFixed(1)}" x2="${t1.toFixed(1)}" y2="${y(botTP).toFixed(1)}" stroke="#16a34a" stroke-width="1.3" stroke-dasharray="7 4"/>`;

      // Zigzag connecting consecutive entries.
      const zig = s.orders
        .map((o) => `${x(o.fillTime).toFixed(1)},${y(o.entry).toFixed(1)}`)
        .join(" ");
      layers += `<polyline points="${zig}" fill="none" stroke="#94a3b8" stroke-width="1.2"/>`;

      // The winning breakout: a single line from the closing leg's entry to the
      // take-profit it reached (intermediate exits are the next entries, already
      // drawn by the zigzag — so no per-leg dangling lines).
      const close = s.orders[s.orders.length - 1];
      if (close && close.hit !== "open") {
        const cColor = close.hit === "tp" ? "#16a34a" : "#dc2626";
        const lx = x(close.fillTime);
        const ly = y(close.entry);
        const cxp = x(close.exitTime);
        const cyp = y(close.exitPrice);
        layers +=
          `<line x1="${lx.toFixed(1)}" y1="${ly.toFixed(1)}" x2="${cxp.toFixed(1)}" y2="${cyp.toFixed(1)}" stroke="${cColor}" stroke-width="1.8"/>` +
          `<circle cx="${cxp.toFixed(1)}" cy="${cyp.toFixed(1)}" r="4.5" fill="${cColor}"/>`;
      }

      // Numbered entries with their lot size.
      for (const o of s.orders) {
        const ex = x(o.fillTime);
        const ey = y(o.entry);
        layers +=
          `<text x="${ex.toFixed(1)}" y="${(ey - 14).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#475569">${o.side === "buy" ? "L" : "S"} ${o.quantity.toPrecision(3)}</text>` +
          `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="9" fill="#e7dcc4" stroke="${o.side === "buy" ? buyColor : sellColor}" stroke-width="2"/>` +
          `<text x="${ex.toFixed(1)}" y="${(ey + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#3f3f46">${o.step}</text>`;
      }

      // Series PnL annotation at the close point.
      const net = s.netProfit;
      const nColor = net >= 0 ? "#16a34a" : "#dc2626";
      const labelY = close ? y(close.exitPrice) - 8 : y(topTP) - 8;
      layers += `<text x="${(x((close ?? s.orders[0]).exitTime) + 6).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="start" font-size="11.5" font-weight="700" fill="${nColor}">S${s.seriesId} ${net >= 0 ? "+" : ""}${fmt(net)}</text>`;

      // Right info panel row.
      const py = m.top + 8 + si * 58;
      panel +=
        `<rect x="${(m.left + pw + 16).toFixed(1)}" y="${py}" width="10" height="10" fill="${color}"/>` +
        `<text x="${(m.left + pw + 32).toFixed(1)}" y="${py + 9}" font-size="12" font-weight="700" fill="#334155">Series ${s.seriesId} · ${s.outcome}</text>` +
        `<text x="${(m.left + pw + 16).toFixed(1)}" y="${py + 26}" font-size="11.5" fill="#64748b">${s.orders.length} steps · ${s.orders[0]?.side === "sell" ? "short-start" : "long-start"}</text>` +
        `<text x="${(m.left + pw + 16).toFixed(1)}" y="${py + 42}" font-size="11.5" fill="${nColor}">net ${net >= 0 ? "+" : ""}${fmt(net)} · gross ${s.grossProfit >= 0 ? "+" : ""}${fmt(s.grossProfit)}</text>`;
    });

    const xLabels =
      `<text x="${m.left}" y="${H - 14}" text-anchor="start" font-size="11" fill="#94a3b8">${day(tMin)}</text>` +
      `<text x="${m.left + pw}" y="${H - 14}" text-anchor="end" font-size="11" fill="#94a3b8">${day(tMax)}</text>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <defs><clipPath id="plot"><rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}"/></clipPath></defs>
  <text x="${m.left}" y="26" font-size="17" font-weight="700" fill="#111827">${esc(input.title ?? "Zone Recovery — trades")}</text>
  <text x="${m.left}" y="45" font-size="12" fill="#6b7280">${esc(input.subtitle ?? "price (grey) · gap zone · TP envelope (green) · numbered entries with lots")}</text>
  ${grid}
  <polyline points="${priceLine}" fill="none" stroke="#cbd5e1" stroke-width="1" clip-path="url(#plot)"/>
  ${layers}
  ${panel}
  ${xLabels}
</svg>
`;
  }

  /** Write the illustrative trades SVG to disk. */
  static writeTradesSvg(input: TradesChartInput, filePath: string): string {
    const svg = ChartExport.tradesSvg(input);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg);
    return filePath;
  }

  /**
   * Schematic "how it works" for ONE recovery series (CAP-diagram style): a
   * step-indexed x-axis (not time), so the alternating entries, the growing lot
   * sizes, the two zone lines, the take-profit corridor and the final breakout
   * are always clearly visible regardless of how fast the series filled.
   */
  static recoverySchematicSvg(
    s: VizSeries,
    options: ChartOptions = {}
  ): string {
    const W = options.width ?? 1080;
    const H = options.height ?? 600;
    const m = { top: 64, right: 150, bottom: 54, left: 78 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const o = s.orders;
    const n = o.length;

    const A = maxOf(o.map((d) => d.entry)); // upper zone line
    const B = minOf(o.map((d) => d.entry)); // lower zone line
    const topTP = maxOf(o.map((d) => d.takeProfit));
    const botTP = minOf(o.map((d) => d.takeProfit));
    const close = o[n - 1];
    let yMin = Math.min(botTP, B, close.exitPrice);
    let yMax = Math.max(topTP, A, close.exitPrice);
    const pad = (yMax - yMin) * 0.14 || 1;
    yMin -= pad;
    yMax += pad;

    const y = (p: number) => m.top + (1 - (p - yMin) / (yMax - yMin)) * ph;
    // Entries occupy the left ~78%; the breakout extends to the right edge.
    const ex = (i: number) => m.left + (n <= 1 ? 0.12 : (i / (n - 1)) * pw * 0.74);

    let grid = "";
    for (let i = 0; i <= 5; i++) {
      const p = yMin + ((yMax - yMin) * i) / 5;
      const yy = y(p);
      grid +=
        `<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>` +
        `<text x="${m.left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#94a3b8">${fmt(p)}</text>`;
    }

    const xL = m.left;
    const xR = m.left + pw;
    // Gap zone + zone lines + take-profit corridor (full width).
    let layers =
      `<rect x="${xL}" y="${y(A).toFixed(1)}" width="${pw}" height="${(y(B) - y(A)).toFixed(1)}" fill="#64748b" fill-opacity="0.09"/>` +
      `<line x1="${xL}" y1="${y(A).toFixed(1)}" x2="${xR}" y2="${y(A).toFixed(1)}" stroke="#2563eb" stroke-width="1.4"/>` +
      `<line x1="${xL}" y1="${y(B).toFixed(1)}" x2="${xR}" y2="${y(B).toFixed(1)}" stroke="#dc2626" stroke-width="1.4"/>` +
      `<line x1="${xL}" y1="${y(topTP).toFixed(1)}" x2="${xR}" y2="${y(topTP).toFixed(1)}" stroke="#16a34a" stroke-width="1.4" stroke-dasharray="7 4"/>` +
      `<line x1="${xL}" y1="${y(botTP).toFixed(1)}" x2="${xR}" y2="${y(botTP).toFixed(1)}" stroke="#16a34a" stroke-width="1.4" stroke-dasharray="7 4"/>` +
      `<text x="${xR}" y="${(y(topTP) - 6).toFixed(1)}" text-anchor="end" font-size="11" fill="#16a34a">Take-Profit</text>` +
      `<text x="${xR}" y="${(y(botTP) + 14).toFixed(1)}" text-anchor="end" font-size="11" fill="#16a34a">Take-Profit</text>`;

    // Zigzag through the entries.
    const zig = o.map((d, i) => `${ex(i).toFixed(1)},${y(d.entry).toFixed(1)}`).join(" ");
    layers += `<polyline points="${zig}" fill="none" stroke="#9ca3af" stroke-width="1.4"/>`;

    // Breakout from the closing entry to its take-profit.
    const cColor = close.hit === "tp" ? "#16a34a" : "#dc2626";
    const bx = Math.min(ex(n - 1) + pw * 0.16, xR);
    layers +=
      `<line x1="${ex(n - 1).toFixed(1)}" y1="${y(close.entry).toFixed(1)}" x2="${bx.toFixed(1)}" y2="${y(close.exitPrice).toFixed(1)}" stroke="${cColor}" stroke-width="2"/>` +
      `<circle cx="${bx.toFixed(1)}" cy="${y(close.exitPrice).toFixed(1)}" r="5" fill="${cColor}"/>`;

    // Numbered entries with lot size.
    o.forEach((d, i) => {
      const cx = ex(i);
      const cy = y(d.entry);
      const above = d.side === "buy";
      layers +=
        `<text x="${cx.toFixed(1)}" y="${(above ? cy - 16 : cy + 24).toFixed(1)}" text-anchor="middle" font-size="11" fill="#475569">${d.side === "buy" ? "Long" : "Short"} ${d.quantity.toPrecision(3)}</text>` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11" fill="#e7dcc4" stroke="${d.side === "buy" ? "#16a34a" : "#dc2626"}" stroke-width="2"/>` +
        `<text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#3f3f46">${d.step}</text>`;
    });

    const nColor = s.netProfit >= 0 ? "#16a34a" : "#dc2626";
    const sub =
      options.subtitle ??
      `${n} steps · first trade loses, each larger hedge recovers until a take-profit closes the whole series`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${m.left}" y="26" font-size="17" font-weight="700" fill="#111827">${esc(options.title ?? "Zone Recovery — how it works")}</text>
  <text x="${m.left}" y="45" font-size="12" fill="#6b7280">${esc(sub)}</text>
  ${grid}
  ${layers}
  <text x="${m.left + pw + 14}" y="${m.top + 6}" font-size="13" font-weight="700" fill="#334155">Series ${s.seriesId}</text>
  <text x="${m.left + pw + 14}" y="${m.top + 26}" font-size="12" fill="${nColor}">net ${s.netProfit >= 0 ? "+" : ""}${fmt(s.netProfit)}</text>
  <text x="${m.left + pw + 14}" y="${m.top + 44}" font-size="12" fill="#64748b">gross ${s.grossProfit >= 0 ? "+" : ""}${fmt(s.grossProfit)}</text>
  <text x="${m.left + pw + 14}" y="${m.top + 62}" font-size="12" fill="#64748b">${n} hedge steps</text>
</svg>
`;
  }

  static writeRecoverySchematicSvg(
    s: VizSeries,
    filePath: string,
    options: ChartOptions = {}
  ): string {
    const svg = ChartExport.recoverySchematicSvg(s, options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg);
    return filePath;
  }

  /**
   * Vertical bar chart anchored at zero — green bars for positive values, red
   * for negative (or per-bar colour). Used for the per-VIP net-PnL proof.
   */
  static barChartSvg(
    bars: { label: string; value: number; color?: string }[],
    options: ChartOptions & { valueSuffix?: string } = {}
  ): string {
    const W = options.width ?? 1040;
    const H = options.height ?? 540;
    const m = { top: 64, right: 28, bottom: 64, left: 86 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;

    const values = bars.map((b) => b.value);
    let yMax = Math.max(0, maxOf(values));
    let yMin = Math.min(0, minOf(values));
    const span = yMax - yMin || 1;
    yMax += span * 0.12;
    yMin -= span * 0.08;
    const y = (v: number) => m.top + (1 - (v - yMin) / (yMax - yMin)) * ph;
    const y0 = y(0);

    let grid = "";
    for (let i = 0; i <= 5; i++) {
      const v = yMin + ((yMax - yMin) * i) / 5;
      const yy = y(v);
      grid +=
        `<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>` +
        `<text x="${m.left - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11.5" fill="#94a3b8">${fmt(v)}</text>`;
    }

    const n = bars.length;
    const slot = pw / n;
    const bw = Math.min(64, slot * 0.62);
    let rects = "";
    bars.forEach((b, i) => {
      const cx = m.left + slot * (i + 0.5);
      const color = b.color ?? (b.value >= 0 ? "#16a34a" : "#dc2626");
      const top = Math.min(y(b.value), y0);
      const h = Math.abs(y(b.value) - y0);
      const labelY = b.value >= 0 ? top - 7 : top + h + 15;
      rects +=
        `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" fill="${color}" rx="2"/>` +
        `<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#334155">${b.value >= 0 ? "+" : ""}${fmt(b.value)}${esc(options.valueSuffix ?? "")}</text>` +
        `<text x="${cx.toFixed(1)}" y="${(H - m.bottom + 18).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="#475569">${esc(b.label)}</text>`;
    });

    // Emphasised zero baseline.
    const zero = `<line x1="${m.left}" y1="${y0.toFixed(1)}" x2="${m.left + pw}" y2="${y0.toFixed(1)}" stroke="#334155" stroke-width="1.4"/>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${m.left}" y="28" font-size="18" font-weight="700" fill="#111827">${esc(options.title ?? "")}</text>
  <text x="${m.left}" y="48" font-size="12.5" fill="#6b7280">${esc(options.subtitle ?? "")}</text>
  ${grid}
  ${rects}
  ${zero}
</svg>
`;
  }

  /** Write a bar chart SVG to disk. */
  static writeBarChartSvg(
    bars: { label: string; value: number; color?: string }[],
    filePath: string,
    options: ChartOptions & { valueSuffix?: string } = {}
  ): string {
    const svg = ChartExport.barChartSvg(bars, options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg);
    return filePath;
  }
}
