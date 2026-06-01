import { describe, expect, test } from "@jest/globals";
import { LeverageBracket } from "../src";

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

  test("tierFor / maintenance margin follow the brackets", () => {
    expect(lb.tierFor(500_000).maxLeverage).toBe(100); // tier 2
    expect(lb.maintenanceMarginRate(500_000)).toBeCloseTo(0.005, 9);
    expect(lb.maintenanceAmount(500_000)).toBe(300);
    // MM = 500,000 × 0.005 − 300 = 2200
    expect(lb.maintenanceMargin(500_000)).toBeCloseTo(2200, 6);
  });
});
