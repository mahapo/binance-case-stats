// Binance USDⓈ-M leverage & margin brackets (position limits).
//
// As a position's notional ("Position Value") grows, the maximum allowed
// leverage drops and the maintenance-margin rate rises. So a chosen leverage
// implies a maximum position value: the largest bracket whose Max Leverage still
// permits that leverage. e.g. 150× → ≤ 300,000 USDT; 100× → ≤ 800,000; 75× → ≤
// 3,000,000; 50× → ≤ 12,000,000.
//
// Source: https://www.binance.com/en/futures/trading-parameters (BTCUSDT Perp).
//   Maintenance Margin = Position Value × MMR − Maintenance Amount.

export interface BracketTier {
  /** Upper bound of the position bracket (Position Value in USDT). */
  maxNotional: number;
  maxLeverage: number;
  /** Maintenance Margin Rate (decimal, e.g. 0.004 = 0.40%). */
  mmr: number;
  /** Maintenance Amount (USDT) — the bracket's cumulative deduction. */
  maintAmount: number;
}

// BTCUSDT Perpetual brackets, ascending by notional.
export const BTCUSDT_BRACKETS: BracketTier[] = [
  { maxNotional: 300_000, maxLeverage: 150, mmr: 0.004, maintAmount: 0 },
  { maxNotional: 800_000, maxLeverage: 100, mmr: 0.005, maintAmount: 300 },
  { maxNotional: 3_000_000, maxLeverage: 75, mmr: 0.0065, maintAmount: 1_500 },
  { maxNotional: 12_000_000, maxLeverage: 50, mmr: 0.01, maintAmount: 12_000 },
  { maxNotional: 70_000_000, maxLeverage: 25, mmr: 0.02, maintAmount: 132_000 },
  { maxNotional: 100_000_000, maxLeverage: 20, mmr: 0.025, maintAmount: 482_000 },
  { maxNotional: 230_000_000, maxLeverage: 10, mmr: 0.05, maintAmount: 2_982_000 },
  { maxNotional: 480_000_000, maxLeverage: 5, mmr: 0.1, maintAmount: 14_482_000 },
  { maxNotional: 600_000_000, maxLeverage: 4, mmr: 0.125, maintAmount: 26_482_000 },
  { maxNotional: 800_000_000, maxLeverage: 3, mmr: 0.15, maintAmount: 41_482_000 },
  { maxNotional: 1_200_000_000, maxLeverage: 2, mmr: 0.25, maintAmount: 121_482_000 },
  { maxNotional: 1_800_000_000, maxLeverage: 1, mmr: 0.5, maintAmount: 421_482_000 },
];

export class LeverageBracket {
  constructor(readonly tiers: BracketTier[] = BTCUSDT_BRACKETS) {}

  /**
   * Maximum position value (notional, USDT) tradable at a given leverage — the
   * largest bracket whose Max Leverage ≥ leverage. Returns 0 if the leverage
   * exceeds every bracket's limit (i.e. it isn't allowed at all).
   */
  maxPositionValue(leverage: number): number {
    let max = 0;
    for (const t of this.tiers) if (t.maxLeverage >= leverage) max = t.maxNotional;
    return max;
  }

  /** The bracket a given position value falls into. */
  tierFor(positionValue: number): BracketTier {
    for (const t of this.tiers) if (positionValue <= t.maxNotional) return t;
    return this.tiers[this.tiers.length - 1];
  }

  maintenanceMarginRate(positionValue: number): number {
    return this.tierFor(positionValue).mmr;
  }

  maintenanceAmount(positionValue: number): number {
    return this.tierFor(positionValue).maintAmount;
  }

  /** Maintenance Margin = Position Value × MMR − Maintenance Amount. */
  maintenanceMargin(positionValue: number): number {
    const t = this.tierFor(positionValue);
    return positionValue * t.mmr - t.maintAmount;
  }
}
