import { getYear, getYearMonth } from "./csv";
import { TradeUnit } from "./positions";

export interface Summary {
  nOrders: number;
  nClosing: number;
  nWins: number;
  nLosses: number;
  nBreakeven: number;
  winRate: number;
  lossRate: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
  rrRatio: number;
  profitFactor: number | null;
  realPnLClosing: number;
  avgTrade: number;
  largestWin: number;
  largestLoss: number;
  maxWinStreak: number;
  maxLossStreak: number;
  notional: number;
}

export interface Distribution {
  mean: number;
  median: number;
  stdDev: number;
  variance: number;
  skewness: number;
  kurtosisExcess: number;
  p1: number; p5: number; p10: number; p25: number;
  p75: number; p90: number; p95: number; p99: number;
}

export interface EquityCurve {
  points: { t: string; cum: number }[];
  maxDrawdown: number;
  finalCum: number;
}

export interface OutcomeBlock {
  overall: Summary;
  distribution: Distribution;
  equityCurve: EquityCurve;
  sequences: {
    closingPnLChrono: number[];
    winLossSeq: number[];
    lossStreaks: number[];
    winStreaks: number[];
    lossStreakHistogram: Record<number, number>;
    winStreakHistogram: Record<number, number>;
  };
  byYear: Record<string, Summary>;
  byMonth: Record<string, Summary>;
}

// Streak lengths for the matching outcome ('win' | 'loss'), in order.
export function streakLengths(closing: TradeUnit[], type: "win" | "loss"): number[] {
  const lengths: number[] = [];
  let cur = 0;
  for (const o of closing) {
    const match = type === "win" ? o.realPnL > 0 : o.realPnL < 0;
    if (match) cur++;
    else {
      if (cur > 0) lengths.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) lengths.push(cur);
  return lengths;
}

const maxOf = (arr: number[]): number => (arr.length ? Math.max(...arr) : 0);

// Histogram of streak lengths -> { length: count }
export function streakHistogram(lengths: number[]): Record<number, number> {
  const h: Record<number, number> = {};
  for (const l of lengths) h[l] = (h[l] || 0) + 1;
  return h;
}

export function basicDistribution(pnls: number[]): Distribution {
  const n = pnls.length;
  const sorted = [...pnls].sort((a, b) => a - b);
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const skewness = n > 2 && stdDev > 0
    ? (pnls.reduce((s, v) => s + ((v - mean) / stdDev) ** 3, 0) / n) * (n / ((n - 1) * (n - 2)))
    : 0;
  const kurtosisExcess = n > 3 && stdDev > 0
    ? pnls.reduce((s, v) => s + ((v - mean) / stdDev) ** 4, 0) / n - 3
    : 0;
  const pct = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (n - 1))))];
  return {
    mean, median, stdDev, variance, skewness, kurtosisExcess,
    p1: pct(1), p5: pct(5), p10: pct(10), p25: pct(25),
    p75: pct(75), p90: pct(90), p95: pct(95), p99: pct(99),
  };
}

export function equityCurve(closing: TradeUnit[]): EquityCurve {
  let cum = 0, peak = 0, maxDD = 0;
  const points: { t: string; cum: number }[] = [];
  for (const o of closing) {
    cum += o.realPnL;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    points.push({ t: o.time.toISOString().slice(0, 10), cum });
  }
  return { points, maxDrawdown: maxDD, finalCum: cum };
}

export function summarise(orders: TradeUnit[]): Summary {
  const closing = orders.filter((o) => o.hasRealizedProfit);
  const wins = closing.filter((o) => o.realPnL > 0);
  const losses = closing.filter((o) => o.realPnL < 0);
  const breakeven = closing.filter((o) => o.realPnL === 0);

  const grossProfit = wins.reduce((s, o) => s + o.realPnL, 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + o.realPnL, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const realPnL = closing.reduce((s, o) => s + o.realPnL, 0);

  const winStreaks = streakLengths(closing, "win");
  const lossStreaks = streakLengths(closing, "loss");

  return {
    nOrders: orders.length,
    nClosing: closing.length,
    nWins: wins.length,
    nLosses: losses.length,
    nBreakeven: breakeven.length,
    winRate: closing.length ? wins.length / closing.length : 0,
    lossRate: closing.length ? losses.length / closing.length : 0,
    grossProfit,
    grossLoss,
    avgWin,
    avgLoss,
    rrRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    realPnLClosing: realPnL, // sum of per-order P&L incl. fill commission
    avgTrade: closing.length ? realPnL / closing.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((o) => o.realPnL)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((o) => o.realPnL)) : 0,
    maxWinStreak: maxOf(winStreaks),
    maxLossStreak: maxOf(lossStreaks),
    notional: orders.reduce((s, o) => s + o.notional, 0),
  };
}

export function byPeriod(orders: TradeUnit[], keyFn: (d: Date) => string): Record<string, Summary> {
  const map = new Map<string, TradeUnit[]>();
  for (const o of orders) {
    const k = keyFn(o.time);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(o);
  }
  const out: Record<string, Summary> = {};
  for (const [k, v] of Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out[k] = summarise(v);
  }
  return out;
}

// Full outcome statistics for a set of "trade units" (orders OR positions).
export function outcomeBlock(units: TradeUnit[]): OutcomeBlock {
  const closed = units.filter((u) => u.hasRealizedProfit);
  const lossStreaks = streakLengths(closed, "loss");
  const winStreaks = streakLengths(closed, "win");
  return {
    overall: summarise(units),
    distribution: basicDistribution(closed.map((u) => u.realPnL)),
    equityCurve: equityCurve(closed),
    sequences: {
      closingPnLChrono: closed.map((u) => u.realPnL),
      winLossSeq: closed.map((u) => (u.realPnL > 0 ? 1 : 0)),
      lossStreaks,
      winStreaks,
      lossStreakHistogram: streakHistogram(lossStreaks),
      winStreakHistogram: streakHistogram(winStreaks),
    },
    byYear: byPeriod(units, getYear),
    byMonth: byPeriod(units, getYearMonth),
  };
}
