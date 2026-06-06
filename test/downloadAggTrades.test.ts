import { describe, expect, test } from "@jest/globals";
import {
  aggTradesUrl,
  isSymbol,
  isPeriod,
  expandPeriods,
} from "../src/data/downloadAggTrades";

describe("aggTrades downloader (URL + arg detection)", () => {
  test("monthly URL", () => {
    expect(aggTradesUrl("AVAXUSDT", "2026-05")).toBe(
      "https://data.binance.vision/data/futures/um/monthly/aggTrades/AVAXUSDT/AVAXUSDT-aggTrades-2026-05.zip"
    );
  });

  test("daily URL", () => {
    expect(aggTradesUrl("avaxusdt", "2025-10-12")).toBe(
      "https://data.binance.vision/data/futures/um/daily/aggTrades/AVAXUSDT/AVAXUSDT-aggTrades-2025-10-12.zip"
    );
  });

  test("isPeriod accepts month and day, rejects others", () => {
    expect(isPeriod("2026-05")).toBe(true);
    expect(isPeriod("2025-10-12")).toBe(true);
    expect(isPeriod("2026")).toBe(false);
    expect(isPeriod("100000")).toBe(false);
  });

  test("isSymbol matches markets, not csv paths or limits", () => {
    expect(isSymbol("AVAXUSDT")).toBe(true);
    expect(isSymbol("BTCUSDC")).toBe(true);
    expect(isSymbol("data/x.csv")).toBe(false);
    expect(isSymbol("200000")).toBe(false);
    expect(isSymbol("BTC/USDT")).toBe(false);
  });
});

describe("expandPeriods (range → ordered periods)", () => {
  test("single period (start === end)", () => {
    expect(expandPeriods("2025-10", "2025-10")).toEqual(["2025-10"]);
    expect(expandPeriods("2025-10-10", "2025-10-10")).toEqual(["2025-10-10"]);
  });

  test("month range, crossing a year", () => {
    expect(expandPeriods("2025-10", "2026-01")).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  test("day range, crossing a month", () => {
    expect(expandPeriods("2025-10-30", "2025-11-02")).toEqual([
      "2025-10-30",
      "2025-10-31",
      "2025-11-01",
      "2025-11-02",
    ]);
  });

  test("rejects mixed granularity and reversed ranges", () => {
    expect(() => expandPeriods("2025-10", "2025-10-12")).toThrow();
    expect(() => expandPeriods("2026-01", "2025-10")).toThrow();
    expect(() => expandPeriods("2025-10-12", "2025-10-10")).toThrow();
  });
});
