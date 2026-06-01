// Parameter-sweep helper: turn a set of numeric ranges into the full cartesian
// product of parameter combinations, so the backtester can be run over many
// settings at once (leverage × ratio × maxSteps × gapPercent × …).

export interface ParamRange {
  key: string;
  start: number;
  end: number;
  step: number;
}

export type ParamCombo = Record<string, number>;

export class Matrix {
  /** Expand one range into its discrete values, e.g. {2,4,0.5} → [2,2.5,3,3.5,4]. */
  static expand(range: ParamRange): number[] {
    if (range.step <= 0) throw new Error(`step must be > 0 for "${range.key}"`);
    const count = Math.floor((range.end - range.start) / range.step + 1e-9) + 1;
    return Array.from({ length: Math.max(count, 1) }, (_, i) =>
      parseFloat((range.start + range.step * i).toFixed(10))
    );
  }

  /** Cartesian product of arrays: [[1,2],[3]] → [[1,3],[2,3]]. */
  static cartesian<T>(arrays: T[][]): T[][] {
    return arrays.reduce<T[][]>(
      (acc, arr) => acc.flatMap((combo) => arr.map((v) => [...combo, v])),
      [[]]
    );
  }

  /** Expand ranges and return every combination as a {key: value} object. */
  static fromRanges(ranges: ParamRange[]): ParamCombo[] {
    const keys = ranges.map((r) => r.key);
    const values = ranges.map((r) => Matrix.expand(r));
    return Matrix.cartesian(values).map((combo) =>
      keys.reduce<ParamCombo>((acc, key, i) => {
        acc[key] = combo[i];
        return acc;
      }, {})
    );
  }
}
