import {
  chiSquareSf,
  logBinomPmf,
  normalSf,
  studentTSf2,
} from "./mathx";

// All inference is driven by an injected PRNG (mulberry32) so bootstrap and
// Monte-Carlo figures are reproducible from a fixed seed.

export interface Histogram {
  min: number;
  max: number;
  counts: number[]; // equal-width bins spanning [min, max]
}

function linearHistogram(values: number[], nbins: number): Histogram {
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const counts = new Array(nbins).fill(0);
  const span = max - min || 1;
  for (const v of values) {
    let b = Math.floor(((v - min) / span) * nbins);
    if (b >= nbins) b = nbins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  return { min, max, counts };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// 1) Bootstrap CI for the mean per-trade P&L + one-sample t-test against 0.
// ---------------------------------------------------------------------------
export interface BootstrapResult {
  meanPnlPerTrade: number;
  bootstrapCi95: [number, number];
  bootstrapPMeanGe0: number;
  ttestT: number;
  ttestPTwoSided: number;
  nTrades: number;
  histogram: Histogram;
}

export function bootstrapMeanCI(
  pnl: number[],
  nBoot: number,
  rng: () => number,
): BootstrapResult {
  const n = pnl.length;
  const mean = pnl.reduce((s, v) => s + v, 0) / n;
  const variance = pnl.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const tStat = mean / (sd / Math.sqrt(n));
  const tP = studentTSf2(tStat, n - 1);

  const bootMeans = new Array<number>(nBoot);
  let geZero = 0;
  for (let b = 0; b < nBoot; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pnl[(rng() * n) | 0];
    const m = sum / n;
    bootMeans[b] = m;
    if (m >= 0) geZero++;
  }
  const sorted = [...bootMeans].sort((a, b) => a - b);
  return {
    meanPnlPerTrade: mean,
    bootstrapCi95: [percentile(sorted, 2.5), percentile(sorted, 97.5)],
    bootstrapPMeanGe0: geZero / nBoot,
    ttestT: tStat,
    ttestPTwoSided: tP,
    nTrades: n,
    histogram: linearHistogram(bootMeans, 80),
  };
}

// ---------------------------------------------------------------------------
// 2) Wilson score 95% CI for a proportion.
// ---------------------------------------------------------------------------
export function wilsonCI(p: number, n: number): [number, number] {
  const z = 1.959963985;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [centre - half, centre + half];
}

// ---------------------------------------------------------------------------
// 3) Monte-Carlo distribution of the maximum loss streak under a given loss
//    probability -> empirical p-value for the observed streak.
// ---------------------------------------------------------------------------
export interface MaxStreakResult {
  pValueGeObserved: number;
  medianMaxStreak: number;
  p95MaxStreak: number;
  p99MaxStreak: number;
  histogram: Record<number, number>;
}

export function monteCarloMaxStreak(
  nTrials: number,
  pLoss: number,
  nSims: number,
  observed: number,
  rng: () => number,
): MaxStreakResult {
  const maxStreaks = new Array<number>(nSims);
  let geObserved = 0;
  const hist: Record<number, number> = {};
  for (let s = 0; s < nSims; s++) {
    let run = 0, best = 0;
    for (let j = 0; j < nTrials; j++) {
      if (rng() < pLoss) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    maxStreaks[s] = best;
    hist[best] = (hist[best] || 0) + 1;
    if (best >= observed) geObserved++;
  }
  const sorted = maxStreaks.sort((a, b) => a - b);
  return {
    pValueGeObserved: geObserved / nSims,
    medianMaxStreak: percentile(sorted, 50),
    p95MaxStreak: percentile(sorted, 95),
    p99MaxStreak: percentile(sorted, 99),
    histogram: hist,
  };
}

// ---------------------------------------------------------------------------
// 4) Wald-Wolfowitz runs test for independence / clustering of a 0/1 sequence.
// ---------------------------------------------------------------------------
export interface RunsTestResult {
  observedRuns: number;
  expectedRuns: number;
  z: number;
  pTwoSided: number;
  interpretation: string;
}

export function runsTest(seq: number[], nWins: number, nLosses: number): RunsTestResult {
  const N = seq.length;
  let runs = 1;
  for (let i = 1; i < N; i++) if (seq[i] !== seq[i - 1]) runs++;
  const mu = (2 * nWins * nLosses) / N + 1;
  const variance = (2 * nWins * nLosses * (2 * nWins * nLosses - N)) / (N * N * (N - 1));
  const z = (runs - mu) / Math.sqrt(variance);
  const p = 2 * normalSf(Math.abs(z));
  return {
    observedRuns: runs,
    expectedRuns: mu,
    z,
    pTwoSided: p,
    interpretation:
      (z < 0 ? "fewer runs than expected -> clustering" : "more runs than expected -> alternation") +
      (p >= 0.05 ? "  (NOT significant)" : "  (significant)"),
  };
}

// Expected number of maximal runs of exactly length k (iid Bernoulli).
export function expectedRunCounts(n: number, pEvent: number, lengths: number[]): number[] {
  const q = 1 - pEvent;
  return lengths.map((k) =>
    k < n ? (n - k - 1) * q * q * pEvent ** k + 2 * q * pEvent ** k : pEvent ** n,
  );
}

// ---------------------------------------------------------------------------
// 5) Exact binomial test of a win count against a reference win probability.
//    One-sided lower tail (P[X <= k], the "below break-even" claim) plus the
//    two-sided p-value (sum of all outcomes no more likely than the observed).
// ---------------------------------------------------------------------------
export interface BinomialResult {
  n: number;
  wins: number;
  observedWinRate: number;
  p0: number;
  expectedWins: number;
  pLower: number;
  pTwoSided: number;
}

export function binomialTest(wins: number, n: number, p0: number): BinomialResult {
  let pLower = 0;
  for (let i = 0; i <= wins; i++) pLower += Math.exp(logBinomPmf(i, n, p0));

  const obsLog = logBinomPmf(wins, n, p0);
  const tol = 1e-7;
  let pTwo = 0;
  for (let i = 0; i <= n; i++) {
    if (logBinomPmf(i, n, p0) <= obsLog + tol) pTwo += Math.exp(logBinomPmf(i, n, p0));
  }
  return {
    n,
    wins,
    observedWinRate: wins / n,
    p0,
    expectedWins: n * p0,
    pLower: Math.min(1, pLower),
    pTwoSided: Math.min(1, pTwo),
  };
}

// ---------------------------------------------------------------------------
// 6) Autocorrelation + Ljung-Box test on the win/loss (0/1) sequence.
// ---------------------------------------------------------------------------
export interface LjungBoxResult {
  maxLag: number;
  acf: number[]; // lags 1..maxLag
  Q: number;
  df: number;
  pValue: number;
}

export function ljungBox(seq: number[], maxLag: number): LjungBoxResult {
  const n = seq.length;
  const mean = seq.reduce((s, v) => s + v, 0) / n;
  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += (seq[i] - mean) ** 2;
  const acf: number[] = [];
  let Q = 0;
  for (let k = 1; k <= maxLag; k++) {
    let ck = 0;
    for (let i = 0; i < n - k; i++) ck += (seq[i] - mean) * (seq[i + k] - mean);
    const rk = ck / c0;
    acf.push(rk);
    Q += (rk * rk) / (n - k);
  }
  Q *= n * (n + 2);
  return { maxLag, acf, Q, df: maxLag, pValue: chiSquareSf(Q, maxLag) };
}

// ---------------------------------------------------------------------------
// 7) Chi-square goodness-of-fit: observed vs fair-market expected loss-streak
//    length counts. Bins with tiny expected counts are pooled into a final
//    ">=" bucket so the asymptotic chi-square holds.
// ---------------------------------------------------------------------------
// 7) Chi-square goodness-of-fit on the SHAPE of the loss-streak length
//    distribution, CONDITIONAL on the observed number of loss runs.
//
//    Under an iid fair market a maximal loss run has length k with geometric
//    probability (1-p)·p^(k-1) (p = loss probability). Expected per-length counts
//    are R·(1-p)·p^(k-1), where R = observed number of loss runs — so Σexpected =
//    Σobserved by construction. This isolates the *length distribution* (shape)
//    from the *number of runs* (already covered by the runs test), avoiding the
//    total-count mismatch that would invalidate a naive GoF. Bins with expected <
//    minExpected are pooled into a trailing ">=" bin; df = (#bins − 1) because only
//    the total is constrained (p is supplied, not estimated from the streak data).
// ---------------------------------------------------------------------------
export interface ChiSquareFitResult {
  baseline: string;
  pLoss: number;
  nRuns: number;
  lengths: number[]; // bin labels (last, -1, is the pooled ">=" bin)
  observed: number[];
  expected: number[];
  chi2: number;
  df: number;
  pValue: number;
}

export function chiSquareStreakFit(
  observedHist: Record<number, number>,
  pLoss: number,
  minExpected = 5,
): ChiSquareFitResult {
  const maxLen = Math.max(...Object.keys(observedHist).map(Number), 1);
  const nRuns = Object.values(observedHist).reduce((s, v) => s + v, 0);
  const geom = (k: number): number => nRuns * (1 - pLoss) * pLoss ** (k - 1);

  const lengths: number[] = [];
  const observed: number[] = [];
  const expected: number[] = [];
  let poolObs = 0, poolExp = 0, pooling = false;
  for (let k = 1; k <= maxLen; k++) {
    const o = observedHist[k] || 0;
    const e = geom(k);
    if (pooling || e < minExpected) {
      pooling = true;
      poolObs += o;
      poolExp += e;
    } else {
      lengths.push(k);
      observed.push(o);
      expected.push(e);
    }
  }
  // Fold the geometric tail beyond maxLen into the pooled bin so Σexpected ==
  // Σobserved exactly (proper conditional multinomial GoF).
  poolExp += nRuns - (expected.reduce((s, v) => s + v, 0) + poolExp);
  if (poolObs > 0 || poolExp > 0) {
    lengths.push(-1);
    observed.push(poolObs);
    expected.push(poolExp);
  }
  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) {
    if (expected[i] > 0) chi2 += (observed[i] - expected[i]) ** 2 / expected[i];
  }
  const df = Math.max(1, observed.length - 1);
  return {
    baseline: "fair market — geometric run lengths (conditional on run count)",
    pLoss,
    nRuns,
    lengths,
    observed,
    expected,
    chi2,
    df,
    pValue: chiSquareSf(chi2, df),
  };
}
