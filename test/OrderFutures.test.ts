import { describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { OrderFutures, PositionFutures, FeeSchedule } from "../src/models";

// ===========================================================================
// FeeSchedule — the configurable Binance futures fee structure
// ===========================================================================
describe("FeeSchedule", () => {
  test("Regular User (VIP 0) USDT rates from the published table", () => {
    const fs0 = FeeSchedule.vip(0);
    expect(fs0.makerRate).toBeCloseTo(0.0002, 10); // 0.0200%
    expect(fs0.takerRate).toBeCloseTo(0.0005, 10); // 0.0500%
  });

  test("VIP levels lower the rates", () => {
    expect(FeeSchedule.vip(3).makerRate).toBeCloseTo(0.00012, 10); // 0.0120%
    expect(FeeSchedule.vip(3).takerRate).toBeCloseTo(0.00032, 10); // 0.0320%
    expect(FeeSchedule.vip(9).makerRate).toBeCloseTo(0.0, 10); // 0.0000%
    expect(FeeSchedule.vip(9).takerRate).toBeCloseTo(0.00017, 10); // 0.0170%
  });

  test("BNB 10% discount multiplies rates by 0.9", () => {
    const fs0 = FeeSchedule.vip(0, { bnbDiscount: true });
    expect(fs0.makerRate).toBeCloseTo(0.00018, 10); // 0.0180%
    expect(fs0.takerRate).toBeCloseTo(0.00045, 10); // 0.0450%
  });

  test("USDC quote uses the USDC column", () => {
    const usdc = FeeSchedule.vip(0, { quote: "USDC" });
    expect(usdc.makerRate).toBeCloseTo(0.0, 10); // 0.0000%
    expect(usdc.takerRate).toBeCloseTo(0.0004, 10); // 0.0400%
  });

  test("explicit rates override the table (for historical schedules)", () => {
    const historical = new FeeSchedule({ maker: 0.0002, taker: 0.0004 });
    expect(historical.makerRate).toBeCloseTo(0.0002, 10);
    expect(historical.takerRate).toBeCloseTo(0.0004, 10);
  });

  test("feeFor charges notional × rate, rounded to 8 decimals", () => {
    const fs0 = FeeSchedule.vip(0);
    // taker on 100,000 notional: 100000 × 0.0005 = 50
    expect(fs0.feeFor(100000, { maker: false })).toBeCloseTo(50, 8);
    // maker on 100,000 notional: 100000 × 0.0002 = 20
    expect(fs0.feeFor(100000, { maker: true })).toBeCloseTo(20, 8);
    // exact Binance rounding from a real fill: 3848.10 × 0.0002 = 0.76962
    expect(new FeeSchedule({ maker: 0.0002 }).feeFor(3848.1, { maker: true })).toBe(
      0.76962
    );
  });
});

// ===========================================================================
// OrderFutures — a single fill / order ticket
// ===========================================================================
describe("OrderFutures", () => {
  describe("size & margin", () => {
    test("constructs from base quantity", () => {
      const o = new OrderFutures({
        price: 100000,
        quantity: 1,
        side: "buy",
        symbol: "BTC/USDT",
        leverage: 20,
      });
      expect(o.quantity).toBe(1);
      expect(o.amount).toBe(100000); // notional = qty × price
      expect(o.initialMargin).toBeCloseTo(5000, 6); // 100000 / 20
    });

    test("constructs from notional (legacy amount)", () => {
      const o = new OrderFutures({
        price: 50000,
        amount: 1000,
        side: "buy",
        symbol: "BTC/USDT",
        leverage: 125,
      });
      expect(o.amount).toBe(1000);
      expect(o.amountUsd).toBe(1000);
      expect(o.quantity).toBeCloseTo(0.02, 6); // 1000 / 50000
      expect(o.margin).toBe(8); // 1000 / 125
    });

    test("constructs from amountUsd", () => {
      const o = new OrderFutures({
        price: 111459,
        amountUsd: 1000,
        side: "buy",
        symbol: "BTC/USDT",
        leverage: 125,
      });
      expect(o.amount).toBe(1000);
      expect(o.quantity).toBeCloseTo(0.00897, 5);
      expect(o.margin).toBe(8);
    });

    test("throws when no size is given", () => {
      expect(
        () =>
          new OrderFutures({ price: 50000, side: "buy", symbol: "BTC/USDT" })
      ).toThrow("quantity, amount or amountUsd missing");
    });
  });

  describe("profit & ROI (USDⓈ-M)", () => {
    test("long 20x — profit", () => {
      const o = new OrderFutures({
        price: 100000,
        quantity: 1,
        leverage: 20,
        side: "buy",
        symbol: "BTC/USDT",
      });
      o.priceExit = 120000;
      expect(o.profit).toBeCloseTo(20000, 2);
      expect(o.roi).toBeCloseTo(4.0, 2); // 20000 / 5000
    });

    test("short 20x — loss", () => {
      const o = new OrderFutures({
        price: 100000,
        quantity: 1,
        leverage: 20,
        side: "sell",
        symbol: "BTC/USDT",
      });
      o.priceExit = 120000;
      expect(o.profit).toBeCloseTo(-20000, 2);
      expect(o.roi).toBeCloseTo(-4.0, 2);
    });

    test("long 90x — loss", () => {
      const o = new OrderFutures({
        price: 20000,
        quantity: 2,
        leverage: 90,
        side: "buy",
        symbol: "BTC/USDT",
      });
      o.priceExit = 19000;
      expect(o.profit).toBeCloseTo(-2000, 2);
      expect(o.roi).toBeCloseTo(-4.5, 1);
    });
  });

  describe("target price", () => {
    test("long 60x — 100% ROI", () => {
      const o = new OrderFutures({
        price: 10000,
        amount: 60000,
        leverage: 60,
        side: "buy",
        symbol: "BTC/USDT",
      });
      expect(o.calculateTargetPrice(1.0)).toBe(10166.66);
    });

    test("short 60x — 100% ROI", () => {
      const o = new OrderFutures({
        price: 10000,
        amount: 60000,
        leverage: 60,
        side: "sell",
        symbol: "BTC/USDT",
      });
      expect(o.calculateTargetPrice(1.0)).toBeCloseTo(9833.33, 2);
    });
  });

  describe("liquidation price (One-Way)", () => {
    test("long 60x", () => {
      const o = new OrderFutures({
        price: 10000,
        amount: 10000,
        leverage: 60,
        side: "buy",
        symbol: "BTC/USDT",
      });
      expect(o.calculateLiquidationPrice(1000, 0.004)).toBeCloseTo(9036.14, 2);
    });

    test("short 60x", () => {
      const o = new OrderFutures({
        price: 10000,
        amount: 10000,
        leverage: 60,
        side: "sell",
        symbol: "BTC/USDT",
      });
      expect(o.calculateLiquidationPrice(1000, 0.004)).toBeCloseTo(10956.17, 1);
    });
  });

  describe("max open quantity", () => {
    test("Balance × Leverage / Price", () => {
      const o = new OrderFutures({
        price: 100000,
        amount: 1,
        leverage: 30,
        side: "buy",
        symbol: "BTC/USDT",
      });
      expect(o.calculateMaxOpenQuantity(300)).toBeCloseTo(0.09, 2);
    });
  });

  describe("average price", () => {
    test("volume-weighted across orders", () => {
      const orders = [
        new OrderFutures({ price: 90000, quantity: 2, side: "buy", symbol: "BTC/USDT" }),
        new OrderFutures({ price: 91000, quantity: 1, side: "buy", symbol: "BTC/USDT" }),
        new OrderFutures({ price: 92000, quantity: 4, side: "buy", symbol: "BTC/USDT" }),
      ];
      // (180000 + 91000 + 368000) / 7 = 91285.71
      expect(OrderFutures.calculateAveragePrice(orders)).toBeCloseTo(91285.71, 2);
    });
  });

  describe("fees", () => {
    test("uses the configured fee schedule (maker/taker)", () => {
      const taker = new OrderFutures({
        price: 50000,
        amount: 100000,
        leverage: 20,
        side: "buy",
        symbol: "BTC/USDT",
        feeSchedule: FeeSchedule.vip(0),
        maker: false,
      });
      expect(taker.fee).toBeCloseTo(50, 6); // 100000 × 0.0005

      const maker = new OrderFutures({
        price: 50000,
        amount: 100000,
        leverage: 20,
        side: "buy",
        symbol: "BTC/USDT",
        feeSchedule: FeeSchedule.vip(0),
        maker: true,
      });
      expect(maker.fee).toBeCloseTo(20, 6); // 100000 × 0.0002
    });
  });

  describe("flags", () => {
    test("reduceOnly / postOnly default false and pass through", () => {
      const a = new OrderFutures({
        price: 50000,
        amount: 100000,
        side: "buy",
        symbol: "BTC/USDT",
        reduceOnly: true,
      });
      expect(a.reduceOnly).toBe(true);
      expect(a.postOnly).toBe(false);

      const b = new OrderFutures({
        price: 50000,
        amount: 100000,
        side: "buy",
        symbol: "BTC/USDT",
      });
      expect(b.reduceOnly).toBe(false);
      expect(b.postOnly).toBe(false);
    });
  });

  describe("break-even (testnet-verified, BNB-10%-off maker rate 0.018%)", () => {
    const bnb = FeeSchedule.vip(0, { bnbDiscount: true });

    test("short — entry 109715.08 → 109675.58", () => {
      const o = new OrderFutures({
        price: 109715.08,
        amount: 1000,
        leverage: 125,
        side: "sell",
        symbol: "BTC/USDT",
        feeSchedule: bnb,
      });
      expect(o.breakEvenPrice).toBeCloseTo(109675.58, 2);
      expect(o.initialMargin).toBeCloseTo(8, 2);
    });

    test("long — entry 110028.00 → 110067.61", () => {
      const o = new OrderFutures({
        price: 110028.0,
        quantity: 1,
        leverage: 75,
        side: "buy",
        symbol: "BTC/USDT",
        feeSchedule: bnb,
      });
      expect(o.breakEvenPrice).toBeCloseTo(110067.61, 2);
      expect(o.initialMargin).toBeCloseTo(1467.04, 2);
      o.priceExit = 109561.2;
      expect(o.profit).toBeCloseTo(-466.8, 2);
      expect(o.roi).toBeCloseTo(-0.318191733, 6);
    });
  });
});

// ===========================================================================
// PositionFutures — weighted-average-cost realized-profit engine
// ===========================================================================
describe("PositionFutures", () => {
  test("opening then increasing updates the average entry price", () => {
    const p = new PositionFutures("BTCUSDT");
    p.applyFill({ price: 100, quantity: 1, side: "buy" });
    p.applyFill({ price: 200, quantity: 1, side: "buy" });
    expect(p.netQty).toBeCloseTo(2, 9);
    expect(p.avgEntryPrice).toBeCloseTo(150, 9);
    expect(p.realizedProfit).toBeCloseTo(0, 9);
    expect(p.side).toBe("long");
  });

  test("reducing a long realizes (exit − avg) × qty and keeps avg", () => {
    const p = new PositionFutures("BTCUSDT");
    p.applyFill({ price: 100, quantity: 2, side: "buy" });
    const r = p.applyFill({ price: 150, quantity: 1, side: "sell" });
    expect(r.realizedProfit).toBeCloseTo(50, 9); // (150 − 100) × 1
    expect(p.netQty).toBeCloseTo(1, 9);
    expect(p.avgEntryPrice).toBeCloseTo(100, 9); // unchanged by a reduction
  });

  test("closing a short realizes (avg − exit) × qty and resets to flat", () => {
    const p = new PositionFutures("BTCUSDT");
    p.applyFill({ price: 100, quantity: 1, side: "sell" });
    const r = p.applyFill({ price: 80, quantity: 1, side: "buy" });
    expect(r.realizedProfit).toBeCloseTo(20, 9); // (100 − 80) × 1
    expect(p.isOpen).toBe(false);
    expect(p.avgEntryPrice).toBe(0);
  });

  test("a flip closes the position and reopens at the fill price", () => {
    const p = new PositionFutures("BTCUSDT");
    p.applyFill({ price: 100, quantity: 1, side: "buy" });
    const r = p.applyFill({ price: 120, quantity: 3, side: "sell" });
    expect(r.realizedProfit).toBeCloseTo(20, 9); // closed 1 @ (120 − 100)
    expect(p.side).toBe("short");
    expect(p.netQty).toBeCloseTo(-2, 9);
    expect(p.avgEntryPrice).toBeCloseTo(120, 9); // remainder opened at fill price
  });

  test("fees accumulate via the fee schedule", () => {
    const p = new PositionFutures("BTCUSDT", FeeSchedule.vip(0));
    p.applyFill({ price: 100000, quantity: 1, side: "buy", maker: false }); // taker 0.05% → 50
    p.applyFill({ price: 110000, quantity: 1, side: "sell", maker: false }); // 110000 × 0.0005 = 55
    expect(p.totalFee).toBeCloseTo(105, 6);
    expect(p.realizedProfit).toBeCloseTo(10000, 6);
    expect(p.netRealized).toBeCloseTo(9895, 6); // 10000 − 105
  });
});

// ===========================================================================
// Integration: reconcile against the REAL Binance USD-M trade exports.
// account/futures/USD-M/trades/*.csv — official "Trade History" export.
// ===========================================================================
interface RawFill {
  time: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  amount: number; // notional
  fee: number; // negative cost as exported
  realizedProfit: number;
  maker: boolean;
  tradeId: number;
}

const TRADES_DIR = path.resolve(__dirname, "../account/futures/USD-M/trades");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const num = (v: string): number => {
  if (!v) return 0;
  const n = parseFloat(v.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
};
// "Fee" looks like "-0.76961999 USDT"; "Realized Profit" like "0E-8" or "-2.78".
const feeNum = (v: string): number => {
  const m = String(v).match(/-?\d+\.?\d*([eE][+-]?\d+)?/);
  return m ? parseFloat(m[0]) : 0;
};

function loadAllFills(): RawFill[] {
  const fills: RawFill[] = [];
  for (const file of fs.readdirSync(TRADES_DIR).filter((f) => f.endsWith(".csv"))) {
    const content = fs
      .readFileSync(path.join(TRADES_DIR, file), "utf-8")
      .replace(/^﻿/, "");
    const lines = content.split("\n").filter((l) => l.trim());
    const headers = parseCsvLine(lines[0]);
    const col = (r: string[], name: string) => r[headers.indexOf(name)];
    for (let i = 1; i < lines.length; i++) {
      const r = parseCsvLine(lines[i]);
      if (r.length !== headers.length) continue;
      fills.push({
        time: col(r, "Time(UTC)"),
        symbol: col(r, "Symbol"),
        side: col(r, "Side") as "BUY" | "SELL",
        price: num(col(r, "Price")),
        quantity: num(col(r, "Quantity")),
        amount: num(col(r, "Amount")),
        fee: feeNum(col(r, "Fee")),
        realizedProfit: num(col(r, "Realized Profit")),
        maker: col(r, "Maker") === "true",
        tradeId: Number(col(r, "Trade Id")),
      });
    }
  }
  // Global chronological order; tie-break on trade id within the same second.
  fills.sort((a, b) =>
    a.time < b.time ? -1 : a.time > b.time ? 1 : a.tradeId - b.tradeId
  );
  return fills;
}

describe("Integration — real Binance USD-M trade exports", () => {
  const hasData =
    fs.existsSync(TRADES_DIR) &&
    fs.readdirSync(TRADES_DIR).some((f) => f.endsWith(".csv"));

  (hasData ? describe : describe.skip)("reconciliation", () => {
    const fills = loadAllFills();

    test("loads a non-trivial number of fills", () => {
      expect(fills.length).toBeGreaterThan(1000);
    });

    test("Realized Profit matches Binance for every closed position cycle", () => {
      // Replay fills per symbol; whenever the position returns flat, compare the
      // realized profit accumulated over that cycle against the CSV's own
      // "Realized Profit" sum for the same fills.
      const bySym: Record<string, RawFill[]> = {};
      for (const f of fills) {
        (bySym[f.symbol] ||= []).push(f);
      }

      let cycles = 0;
      let mismatches = 0;
      let worstCycleError = 0;
      let totalCalc = 0;
      let totalCsv = 0;

      for (const symbol of Object.keys(bySym)) {
        const symFills = bySym[symbol];
        const pos = new PositionFutures(symbol);
        let cycleCalc = 0;
        let cycleCsv = 0;
        for (const f of symFills) {
          const r = pos.applyFill({
            price: f.price,
            quantity: f.quantity,
            side: f.side,
            maker: f.maker,
          });
          cycleCalc += r.realizedProfit;
          cycleCsv += f.realizedProfit;
          if (!pos.isOpen) {
            cycles++;
            const err = Math.abs(cycleCalc - cycleCsv);
            worstCycleError = Math.max(worstCycleError, err);
            if (err > 0.02) mismatches++;
            totalCalc += cycleCalc;
            totalCsv += cycleCsv;
            cycleCalc = 0;
            cycleCsv = 0;
          }
        }
      }

      expect(cycles).toBeGreaterThan(100);
      expect(mismatches).toBe(0);
      expect(worstCycleError).toBeLessThan(0.01);
      // Total realized profit across all closed cycles ties out to the cent.
      expect(totalCalc).toBeCloseTo(totalCsv, 1);
    });

    test("FeeSchedule reproduces the exported commission (notional × rate)", () => {
      // Historical taker rate 0.0400% (pre-2024) and 0.0500% (2024+), maker 0.0200%.
      const rates = [0.0002, 0.0004, 0.0005];
      const schedules = rates.map(
        (r) => new FeeSchedule({ maker: r, taker: r })
      );

      let checked = 0;
      let maxError = 0;
      for (const f of fills) {
        if (f.amount <= 0 || f.fee === 0) continue;
        const impliedRate = Math.abs(f.fee) / f.amount;
        const idx = rates.findIndex((r) => Math.abs(impliedRate - r) < 5e-7);
        if (idx === -1) continue; // BNB-paid or promotional rates — skip.
        const calc = schedules[idx].feeFor(f.amount);
        maxError = Math.max(maxError, Math.abs(calc - Math.abs(f.fee)));
        checked++;
      }

      // The bulk of fills fall on one of the three standard rates.
      expect(checked).toBeGreaterThan(fills.length * 0.8);
      // notional × rate rounded to 8 decimals reproduces Binance's commission to
      // within 1e-8 — the residual is Binance's own float-rounding in the export
      // (e.g. 3848.10 × 0.0002 is exported as 0.76961999, not 0.76962000), not a
      // modelling error. 1e-8 USDT is a hundred-millionth of a cent.
      expect(maxError).toBeLessThanOrEqual(1e-8 + 1e-12);
    });
  });
});
