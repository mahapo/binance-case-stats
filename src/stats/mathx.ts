// ---------------------------------------------------------------------------
// Numerical core for the statistical tests. Standard, well-documented routines
// (Numerical Recipes / Abramowitz & Stegun) so the analytic p-values are exact
// and reproducible without an external dependency — matching scipy to ~1e-7.
// ---------------------------------------------------------------------------

const SQRT2 = Math.SQRT2;

// Complementary error function, Chebyshev fit (Numerical Recipes `erfcc`).
// Fractional error < 1.2e-7 everywhere, including the deep tails.
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 +
          t * (0.37409196 +
            t * (0.09678418 +
              t * (-0.18628806 +
                t * (0.27886807 +
                  t * (-1.13520398 +
                    t * (1.48851587 +
                      t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? ans : 2 - ans;
}

// Standard normal CDF and survival (upper tail).
export const normalCdf = (x: number): number => 0.5 * erfc(-x / SQRT2);
export const normalSf = (x: number): number => 0.5 * erfc(x / SQRT2);

// log Γ(x), Lanczos approximation (Numerical Recipes `gammln`).
export function logGamma(xx: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let x = xx;
  let y = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Regularized lower incomplete gamma P(a,x) via series (gser) / continued
// fraction (gcf), and its complement Q(a,x) (Numerical Recipes).
function gser(a: number, x: number): number {
  const ITMAX = 300;
  const EPS = 3e-12;
  if (x <= 0) return 0;
  const gln = logGamma(a);
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

function gcf(a: number, x: number): number {
  const ITMAX = 300;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const gln = logGamma(a);
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

export function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  return x < a + 1 ? gser(a, x) : 1 - gcf(a, x);
}
export const gammaQ = (a: number, x: number): number => 1 - gammaP(a, x);

// Chi-square survival function (upper tail p-value) for a statistic with df dof.
export const chiSquareSf = (stat: number, df: number): number => gammaQ(df / 2, stat / 2);

// Regularized incomplete beta I_x(a,b) (Numerical Recipes `betai` + `betacf`).
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (bt * betacf(a, b, x)) / a
    : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// Two-sided p-value for a Student-t statistic with df degrees of freedom.
export const studentTSf2 = (t: number, df: number): number =>
  incompleteBeta(df / 2, 0.5, df / (df + t * t));

// log binomial pmf: log C(n,k) + k log p + (n-k) log(1-p).
export function logBinomPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return -Infinity;
  const logChoose = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  const lp = p <= 0 ? (k === 0 ? 0 : -Infinity) : Math.log(p);
  const lq = p >= 1 ? (k === n ? 0 : -Infinity) : Math.log(1 - p);
  return logChoose + k * lp + (n - k) * lq;
}
