import { describe, expect, test } from "@jest/globals";
import { ZoneRecovery, Recovery, FeeSchedule } from "../src";

// ===========================================================================
// ZoneRecovery — zone geometry & sizing
// ===========================================================================
describe("ZoneRecovery geometry & sizing", () => {
  // gapPercent 30 at leverage 100 on entry 10000 → gap = (30/100/100)·10000 = 30.
  const base = {
    symbol: "BTC/USDT",
    ratio: 2,
    leverage: 100,
    gapPercent: 30,
    baseQuantity: 0.001,
  };

  test("long start: stop-loss = entry − gap, take-profit = entry + ratio·gap", () => {
    const zr = new ZoneRecovery({ ...base, entryPrice: 10000, side: "buy" });
    const [o0, o1, o2] = zr.buildOrders(3);

    expect(o0.side).toBe("buy");
    expect(o0.price).toBe(10000);
    expect(o0.stopLoss).toBeCloseTo(9970, 9); // 10000 − 30
    expect(o0.takeProfit).toBeCloseTo(10060, 9); // 10000 + 2·30

    // Next entry is the previous stop-loss, opposite side.
    expect(o1.side).toBe("sell");
    expect(o1.price).toBeCloseTo(9970, 9);
    expect(o1.stopLoss).toBeCloseTo(10000, 9); // 9970 + 30
    expect(o1.takeProfit).toBeCloseTo(9910, 9); // 9970 − 2·30

    // Entries alternate between the two lines A=10000 and B=9970.
    expect(o2.side).toBe("buy");
    expect(o2.price).toBeCloseTo(10000, 9);
  });

  test("short start mirrors the sides", () => {
    const zr = new ZoneRecovery({ ...base, entryPrice: 10000, side: "sell" });
    const [o0, o1] = zr.buildOrders(2);
    expect(o0.side).toBe("sell");
    expect(o0.stopLoss).toBeCloseTo(10030, 9); // 10000 + 30
    expect(o0.takeProfit).toBeCloseTo(9940, 9); // 10000 − 2·30
    expect(o1.side).toBe("buy");
    expect(o1.price).toBeCloseTo(10030, 9);
  });

  test("size grows by M = 1 + 1/ratio each step", () => {
    const zr = new ZoneRecovery({ ...base, entryPrice: 10000, side: "buy" });
    const M = 1 + 1 / base.ratio; // 1.5
    for (let i = 0; i < 6; i++) {
      expect(zr.quantityAt(i)).toBeCloseTo(base.baseQuantity * Math.pow(M, i), 12);
    }
  });

  test("percentage gap is leverage-adjusted off the entry price", () => {
    const zr = new ZoneRecovery({
      symbol: "BTC/USDT",
      entryPrice: 10000,
      side: "buy",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      baseQuantity: 0.001,
    });
    expect(zr.gap).toBeCloseTo(30, 9); // (30/100/100)·10000
  });
});

// ===========================================================================
// ★ The invariant: every completed series nets the SAME gross profit,
//   regardless of how many recovery steps it took. (Fees are separate.)
// ===========================================================================
describe("Recovery — constant gross PnL per series (the headline invariant)", () => {
  // Drive a series deterministically to win on its N-th step:
  // N−1 stop-losses, then a take-profit on step N.
  function runSeriesWinningOnStep(strategy: Recovery, N: number) {
    strategy.onSignal(10000, 0);
    for (let s = 1; s < N; s++) strategy.onStopLoss(strategy.currentOrder!);
    strategy.onTakeProfit(strategy.currentOrder!);
    return strategy.series[strategy.series.length - 1];
  }

  for (const ratio of [1, 2, 3, 5]) {
    test(`ratio ${ratio}: gross profit identical for series winning on step 1..maxSteps`, () => {
      const maxSteps = 8;
      const leverage = 100;
      const gapPercent = 30;
      const price = 10000;
      const gap = (gapPercent / 100 / leverage) * price; // 30
      const baseQuantity = 0.001;
      const expected = ratio * gap * baseQuantity; // ZoneRecovery.seriesGrossTarget

      const strategy = new Recovery({
        symbol: "BTC/USDT",
        ratio,
        leverage,
        gapPercent,
        baseQuantity,
        maxSteps,
        forceSide: "buy",
        feeSchedule: FeeSchedule.vip(0),
      });

      const gross: number[] = [];
      const fees: number[] = [];
      for (let N = 1; N <= maxSteps; N++) {
        const result = runSeriesWinningOnStep(strategy, N);
        expect(result.outcome).toBe("win");
        expect(result.steps).toBe(N);
        gross.push(result.grossProfit);
        fees.push(result.fees);
        // net is exactly gross − fees
        expect(result.netProfit).toBeCloseTo(result.grossProfit - result.fees, 12);
      }

      // Every series produced the same gross profit = ratio·gap·baseQuantity.
      for (const g of gross) expect(g).toBeCloseTo(expected, 9);
      expect(Math.max(...gross) - Math.min(...gross)).toBeLessThan(1e-9);

      // Fees strictly increase with the number of recovery steps.
      for (let i = 1; i < fees.length; i++) {
        expect(fees[i]).toBeGreaterThan(fees[i - 1]);
      }
    });
  }

  test("invariant holds starting from a random short too", () => {
    const ratio = 2;
    const leverage = 100;
    const gapPercent = 25;
    const price = 10000;
    const gap = (gapPercent / 100 / leverage) * price; // 25
    const baseQuantity = 0.002;
    const expected = ratio * gap * baseQuantity;
    const strategy = new Recovery({
      symbol: "ETH/USDT",
      ratio,
      leverage,
      gapPercent,
      baseQuantity,
      maxSteps: 6,
      forceSide: "sell",
    });
    for (let N = 1; N <= 6; N++) {
      const r = runSeriesWinningOnStep(strategy, N);
      expect(r.grossProfit).toBeCloseTo(expected, 9);
    }
  });
});

// ===========================================================================
// Max Hedge Order — loss-taking policies
// ===========================================================================
describe("Recovery — Max Hedge Order policies", () => {
  test("take-loss: hitting every stop-loss realizes the full cumulative loss", () => {
    const ratio = 2;
    const leverage = 100;
    const gapPercent = 30;
    const price = 10000;
    const gap = (gapPercent / 100 / leverage) * price; // 30
    const baseQuantity = 0.001;
    const maxSteps = 4;
    const M = 1 + 1 / ratio;

    const strategy = new Recovery({
      symbol: "BTC/USDT",
      ratio,
      leverage,
      gapPercent,
      baseQuantity,
      maxSteps,
      forceSide: "buy",
      lossTakingPolicy: "take-loss",
    });

    strategy.onSignal(10000, 0);
    for (let s = 0; s < maxSteps; s++) strategy.onStopLoss(strategy.currentOrder!);

    const series = strategy.series[0];
    const totalQty = baseQuantity * ((Math.pow(M, maxSteps) - 1) / (M - 1));
    const expectedLoss = -gap * totalQty;

    expect(series.outcome).toBe("loss");
    expect(series.steps).toBe(maxSteps);
    expect(series.grossProfit).toBeCloseTo(expectedLoss, 9);
  });

  test("breakeven: the final leg's take-profit closes the series flat", () => {
    const strategy = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      baseQuantity: 0.001,
      maxSteps: 4,
      forceSide: "buy",
      lossTakingPolicy: "breakeven",
    });

    strategy.onSignal(10000, 0);
    // Reach the final step via 3 stop-losses, then hit its (breakeven) TP.
    for (let s = 1; s < 4; s++) strategy.onStopLoss(strategy.currentOrder!);
    strategy.onTakeProfit(strategy.currentOrder!);

    const series = strategy.series[0];
    expect(series.outcome).toBe("win");
    expect(series.steps).toBe(4);
    expect(series.grossProfit).toBeCloseTo(0, 9); // flat, before fees
  });
});

// ===========================================================================
// Random side selection
// ===========================================================================
describe("Recovery — random initial side", () => {
  test("rng < 0.5 → long, ≥ 0.5 → short", () => {
    const opts = {
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      baseQuantity: 0.001,
      maxSteps: 4,
    };
    const longStrat = new Recovery({ ...opts, rng: () => 0.1 });
    longStrat.onSignal(10000, 0);
    expect(longStrat.side).toBe("buy");

    const shortStrat = new Recovery({ ...opts, rng: () => 0.9 });
    shortStrat.onSignal(10000, 0);
    expect(shortStrat.side).toBe("sell");
  });

  test("a seed makes the random side reproducible (and seeds differ)", () => {
    const opts = {
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      baseQuantity: 0.001,
      maxSteps: 4,
    };
    // Drive several series, recording the chosen side each time.
    const sidesFor = (seed: number) => {
      const strat = new Recovery({ ...opts, seed });
      const sides: string[] = [];
      for (let i = 0; i < 10; i++) {
        strat.onSignal(10000, 0, 1000);
        sides.push(strat.side);
        strat.onTakeProfit(strat.currentOrder!); // close, ready for next
      }
      return sides;
    };

    const a = sidesFor(1337);
    const b = sidesFor(1337);
    expect(a).toEqual(b); // same seed → identical sequence
    expect(a).toContain("buy");
    expect(a).toContain("sell"); // genuinely mixed
    expect(sidesFor(42)).not.toEqual(a); // different seed → different sequence
  });
});

// ===========================================================================
// Risk-based sizing (1–2% of balance per trade) & fee tier (vipLevel)
// ===========================================================================
describe("Recovery — risk-based sizing & fee tier", () => {
  test("riskPercent sizes the base order's margin off the live balance", () => {
    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      riskPercent: 2, // 2% of balance as margin
      maxSteps: 4,
      forceSide: "buy",
    });
    strat.onSignal(10000, 0, 1000); // balance 1000

    const first = strat.currentOrders[0];
    expect(first.initialMargin).toBeCloseTo(20, 9); // 2% of 1000
    expect(first.amount).toBeCloseTo(2000, 9); // notional = margin × leverage
    expect(first.quantity).toBeCloseTo(0.2, 9); // 2000 / 10000
  });

  test("base size compounds with the balance between series", () => {
    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      riskPercent: 1,
      maxSteps: 4,
      forceSide: "buy",
    });
    strat.onSignal(10000, 0, 1000);
    const q1 = strat.currentOrders[0].quantity;
    strat.onTakeProfit(strat.currentOrder!); // close the series

    strat.onSignal(10000, 0, 2000); // balance doubled
    const q2 = strat.currentOrders[0].quantity;
    expect(q2).toBeCloseTo(q1 * 2, 9);
  });

  test("vipLevel selects the fee tier when no feeSchedule is given", () => {
    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 100,
      gapPercent: 30,
      baseQuantity: 0.001,
      maxSteps: 4,
      vipLevel: 3,
    });
    expect(strat.options.feeSchedule.makerRate).toBeCloseTo(
      FeeSchedule.vip(3).makerRate,
      12
    );
    expect(strat.options.feeSchedule.takerRate).toBeCloseTo(
      FeeSchedule.vip(3).takerRate,
      12
    );
  });

  test("constructor requires a sizing mode", () => {
    expect(
      () =>
        new Recovery({
          symbol: "BTC/USDT",
          ratio: 2,
          leverage: 100,
          gapPercent: 30,
          maxSteps: 4,
        } as any)
    ).toThrow("provide maxDrawdownPercent, riskPercent or baseQuantity");
  });

  test("the constant-gross invariant still holds with risk-based sizing", () => {
    const balance = 1000;
    const leverage = 100;
    const gapPercent = 30;
    const price = 10000;
    const ratio = 2;
    const riskPercent = 2;
    const gap = (gapPercent / 100 / leverage) * price; // 30
    const baseQty = ((riskPercent / 100) * balance * leverage) / price; // 0.2
    const expected = ratio * gap * baseQty; // 12

    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio,
      leverage,
      gapPercent,
      riskPercent,
      maxSteps: 8,
      forceSide: "buy",
    });
    for (let N = 1; N <= 8; N++) {
      strat.onSignal(price, 0, balance);
      for (let s = 1; s < N; s++) strat.onStopLoss(strat.currentOrder!);
      strat.onTakeProfit(strat.currentOrder!);
      expect(strat.series[strat.series.length - 1].grossProfit).toBeCloseTo(
        expected,
        9
      );
    }
  });
});

// ===========================================================================
// Drawdown-based sizing & position-bracket cap
// ===========================================================================
describe("Recovery — drawdown sizing & position bracket", () => {
  test("maxDrawdownPercent: a fully-lost series costs exactly that % of balance", () => {
    const balance = 1000;
    const maxDrawdownPercent = 40;
    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 50, // bracket limit 12M ≫ our size → not capped
      gapPercent: 30,
      maxDrawdownPercent,
      maxSteps: 4,
      forceSide: "buy",
    });

    strat.onSignal(10000, 0, balance);
    for (let s = 0; s < 4; s++) strat.onStopLoss(strat.currentOrder!); // all stop-losses

    const series = strat.series[0];
    expect(series.outcome).toBe("loss");
    // Worst-case loss = maxDrawdownPercent% of balance.
    expect(series.grossProfit).toBeCloseTo(-(maxDrawdownPercent / 100) * balance, 6);
  });

  test("the last hedge is capped to the leverage's position bracket", () => {
    // Huge balance/maxSteps would blow past the 150× bracket (300,000 USDT).
    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 150, // bracket limit = 300,000 USDT
      gapPercent: 10,
      maxDrawdownPercent: 40,
      maxSteps: 12,
      forceSide: "buy",
    });

    strat.onSignal(10000, 0, 1_000_000);
    const last = strat.currentOrders[strat.currentOrders.length - 1];
    expect(last.amount).toBeCloseTo(300_000, 2); // notional capped to the bracket
    // And nothing exceeds it.
    for (const o of strat.currentOrders) expect(o.amount).toBeLessThanOrEqual(300_000 + 1e-6);
  });

  test("no affordable size (zero balance) opens no series", () => {
    const strat = new Recovery({
      symbol: "BTC/USDT",
      ratio: 2,
      leverage: 50,
      gapPercent: 30,
      maxDrawdownPercent: 40,
      maxSteps: 4,
      forceSide: "buy",
    });
    strat.onSignal(10000, 0, 0); // bankrupt
    expect(strat.hasActiveSeries).toBe(false);
    expect(strat.currentOrders.length).toBe(0);
  });
});
