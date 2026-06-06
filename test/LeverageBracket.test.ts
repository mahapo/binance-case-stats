import { describe, expect, test } from "@jest/globals";
import { LeverageBracket, BracketCache } from "../src";
import { bracketsFromCcxtTiers, compactSymbol } from "../src/data/fetchBrackets";

describe("LeverageBracket — BTCUSDT position limits", () => {
  const lb = new LeverageBracket();

  test("maxPositionValue is the largest bracket allowing the leverage", () => {
    expect(lb.maxPositionValue(150)).toBe(300_000);
    expect(lb.maxPositionValue(125)).toBe(300_000); // still only tier 1 allows >100×
    expect(lb.maxPositionValue(100)).toBe(800_000);
    expect(lb.maxPositionValue(75)).toBe(3_000_000);
    expect(lb.maxPositionValue(50)).toBe(12_000_000);
    expect(lb.maxPositionValue(25)).toBe(70_000_000);
    expect(lb.maxPositionValue(1)).toBe(1_800_000_000);
  });

  test("leverage above every bracket is not tradable", () => {
    expect(lb.maxPositionValue(200)).toBe(0);
  });

  test("maxLeverage is the highest leverage the market allows", () => {
    expect(lb.maxLeverage()).toBe(150); // BTCUSDT top tier
    // A cache-backed market that tops out lower (e.g. ETH-like 50×).
    const cache = { ETHUSDT: [{ maxNotional: 50_000, maxLeverage: 50, mmr: 0.01, maintAmount: 0 }] };
    expect(LeverageBracket.forSymbol("ETHUSDT", { cache }).maxLeverage()).toBe(50);
    // Unknown symbol → uncapped fallback.
    expect(LeverageBracket.forSymbol("ZZZUSDT", { cache: {}, warnOnFallback: false }).maxLeverage()).toBe(Infinity);
  });

  test("tierFor / maintenance margin follow the brackets", () => {
    expect(lb.tierFor(500_000).maxLeverage).toBe(100); // tier 2
    expect(lb.maintenanceMarginRate(500_000)).toBeCloseTo(0.005, 9);
    expect(lb.maintenanceAmount(500_000)).toBe(300);
    // MM = 500,000 × 0.005 − 300 = 2200
    expect(lb.maintenanceMargin(500_000)).toBeCloseTo(2200, 6);
  });
});

describe("LeverageBracket.forSymbol (per-market cache)", () => {
  const cache: BracketCache = {
    AVAXUSDC: [
      { maxNotional: 25_000, maxLeverage: 75, mmr: 0.0065, maintAmount: 0 },
      { maxNotional: 100_000, maxLeverage: 50, mmr: 0.01, maintAmount: 87.5 },
      { maxNotional: 1_000_000, maxLeverage: 25, mmr: 0.02, maintAmount: 1087.5 },
    ],
  };

  test("loads the requested market's brackets (much tighter than BTCUSDT)", () => {
    const lb = LeverageBracket.forSymbol("AVAXUSDC", { cache });
    expect(lb.maxPositionValue(75)).toBe(25_000);
    expect(lb.maxPositionValue(50)).toBe(100_000);
    expect(lb.maxPositionValue(25)).toBe(1_000_000);
  });

  test("normalizes ccxt symbol forms", () => {
    expect(LeverageBracket.forSymbol("AVAX/USDC:USDC", { cache }).maxPositionValue(75)).toBe(25_000);
    expect(LeverageBracket.forSymbol("avaxusdc", { cache }).maxPositionValue(75)).toBe(25_000);
  });

  test("USD→USDT/USDC fallback maps Gemini spot symbols", () => {
    const c: BracketCache = { ETHUSDT: cache.AVAXUSDC };
    expect(LeverageBracket.forSymbol("ETHUSD", { cache: c }).maxPositionValue(75)).toBe(25_000);
  });

  test("unknown symbol → permissive (uncapped) fallback", () => {
    const lb = LeverageBracket.forSymbol("DOGEUSDT", { cache, warnOnFallback: false });
    expect(lb.maxPositionValue(100)).toBe(Infinity);
  });

  test("BTC falls back to the built-in BTCUSDT table", () => {
    const lb = LeverageBracket.forSymbol("BTCUSD", { cache: {}, warnOnFallback: false });
    expect(lb.maxPositionValue(125)).toBe(300_000);
  });

  test("public position-size limit caps base qty when no notional brackets", () => {
    const lb = LeverageBracket.forSymbol("AVAXUSDC", {
      limits: { AVAXUSDC: { maxPositionQty: 300_000 } },
      warnOnFallback: false,
    });
    expect(lb.maxBaseQty(25, 75)).toBe(300_000); // uncapped notional → bound by qty
  });

  test("maxBaseQty takes the tighter of notional bracket and position qty", () => {
    const lb = LeverageBracket.forSymbol("AVAXUSDC", {
      cache: { AVAXUSDC: [{ maxNotional: 25_000, maxLeverage: 75, mmr: 0.0065, maintAmount: 0 }] },
      limits: { AVAXUSDC: { maxPositionQty: 500 } },
      warnOnFallback: false,
    });
    // notional cap at $25 → 25000/25 = 1000 base; position-qty cap 500 → min = 500
    expect(lb.maxBaseQty(25, 75)).toBe(500);
  });
});

describe("bracketsFromCcxtTiers mapping", () => {
  test("maps ccxt fetchLeverageTiers output to BracketTier[] (sorted, cum→maintAmount)", () => {
    const tiers = {
      "AVAX/USDC:USDC": [
        { tier: 2, maxNotional: 100_000, maxLeverage: 50, maintenanceMarginRate: 0.01, info: { cum: 87.5 } },
        { tier: 1, maxNotional: 25_000, maxLeverage: 75, maintenanceMarginRate: 0.0065, info: { cum: 0 } },
      ],
    };
    const out = bracketsFromCcxtTiers(tiers as any);
    expect(Object.keys(out)).toEqual(["AVAXUSDC"]);
    expect(out.AVAXUSDC).toEqual([
      { maxNotional: 25_000, maxLeverage: 75, mmr: 0.0065, maintAmount: 0 },
      { maxNotional: 100_000, maxLeverage: 50, mmr: 0.01, maintAmount: 87.5 },
    ]);
  });

  test("compactSymbol strips '/' and settle suffix", () => {
    expect(compactSymbol("AVAX/USDC:USDC")).toBe("AVAXUSDC");
    expect(compactSymbol("BTC/USDT")).toBe("BTCUSDT");
  });
});
