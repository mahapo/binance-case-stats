// Binance USDⓈ-M Futures trading fee schedule.
//
// Fees are charged on the *notional* value of every fill (Price × Quantity),
// with a different rate for the maker (resting order) and taker (order that
// removes liquidity) side. Binance rounds the resulting commission to 8
// decimal places — reproduced here exactly so computed fees match the
// "Fee" column of the official trade export to the satoshi.
//
// The published VIP table (https://www.binance.com/en/fee/futureFee) is encoded
// below. A schedule can be built three ways:
//   1. From a VIP level  -> FeeSchedule.vip(0)               (Regular User)
//   2. With BNB 10% off  -> FeeSchedule.vip(0, { bnbDiscount: true })
//   3. With explicit rates (e.g. for a historical schedule that differs from
//      today's published numbers) -> new FeeSchedule({ maker: 0.0002, taker: 0.0004 })
//
// Note: this account's *historical* exports use a 0.0400% taker rate (pre-2024)
// and a 0.0500% taker rate (2024+). The published "Regular User" taker rate is
// 0.0500%. Because rates change over time, always pass the schedule that was in
// force for the period you are reconstructing.

export type QuoteAsset = "USDT" | "USDC";

export interface VipTier {
  /** USDT-margined Maker / Taker rates (decimal, e.g. 0.0002 = 0.02%). */
  usdt: { maker: number; taker: number };
  /** USDC-margined Maker / Taker rates (decimal). */
  usdc: { maker: number; taker: number };
}

// Values transcribed from the official futures fee page (decimal form).
// Index = VIP level (0 = Regular User .. 9 = VIP 9).
export const VIP_TABLE: VipTier[] = [
  { usdt: { maker: 0.000200, taker: 0.000500 }, usdc: { maker: 0.000000, taker: 0.000400 } }, // Regular
  { usdt: { maker: 0.000180, taker: 0.000500 }, usdc: { maker: 0.000000, taker: 0.000400 } }, // VIP 1
  { usdt: { maker: 0.000160, taker: 0.000400 }, usdc: { maker: 0.000000, taker: 0.000320 } }, // VIP 2
  { usdt: { maker: 0.000120, taker: 0.000320 }, usdc: { maker: 0.000000, taker: 0.000256 } }, // VIP 3
  { usdt: { maker: 0.000100, taker: 0.000300 }, usdc: { maker: 0.000000, taker: 0.000165 } }, // VIP 4
  { usdt: { maker: 0.000080, taker: 0.000270 }, usdc: { maker: 0.000000, taker: 0.000149 } }, // VIP 5
  { usdt: { maker: 0.000060, taker: 0.000250 }, usdc: { maker: 0.000000, taker: 0.000138 } }, // VIP 6
  { usdt: { maker: 0.000040, taker: 0.000220 }, usdc: { maker: 0.000000, taker: 0.000121 } }, // VIP 7
  { usdt: { maker: 0.000020, taker: 0.000200 }, usdc: { maker: 0.000000, taker: 0.000110 } }, // VIP 8
  { usdt: { maker: 0.000000, taker: 0.000170 }, usdc: { maker: 0.000000, taker: 0.000094 } }, // VIP 9
];

// Paying fees with a BNB balance grants a 10% discount on USDⓈ-M futures fees.
export const BNB_DISCOUNT = 0.10;

export interface FeeScheduleOptions {
  /** Explicit maker rate (decimal). Overrides the VIP table when provided. */
  maker?: number;
  /** Explicit taker rate (decimal). Overrides the VIP table when provided. */
  taker?: number;
  /** VIP level 0..9 (0 = Regular User). Defaults to 0. */
  vipLevel?: number;
  /** Margin/quote asset. Defaults to "USDT". */
  quote?: QuoteAsset;
  /** Apply the 10% BNB fee discount. Defaults to false. */
  bnbDiscount?: boolean;
}

export class FeeSchedule {
  readonly makerRate: number;
  readonly takerRate: number;
  readonly vipLevel: number;
  readonly quote: QuoteAsset;
  readonly bnbDiscount: boolean;

  constructor(options: FeeScheduleOptions = {}) {
    this.vipLevel = options.vipLevel ?? 0;
    this.quote = options.quote ?? "USDC";
    this.bnbDiscount = options.bnbDiscount ?? true;

    if (this.vipLevel < 0 || this.vipLevel >= VIP_TABLE.length) {
      throw new Error(`Unknown VIP level: ${this.vipLevel}`);
    }

    const tier = VIP_TABLE[this.vipLevel];
    const base = this.quote === "USDC" ? tier.usdc : tier.usdt;
    const discount = this.bnbDiscount ? 1 - BNB_DISCOUNT : 1;

    // Explicit rates win over the table (used for historical schedules).
    this.makerRate = (options.maker ?? base.maker) * discount;
    this.takerRate = (options.taker ?? base.taker) * discount;
  }

  /** Convenience factory for a VIP level. */
  static vip(
    level: number,
    opts: { quote?: QuoteAsset; bnbDiscount?: boolean } = {}
  ): FeeSchedule {
    return new FeeSchedule({ vipLevel: level, ...opts });
  }

  /** Rate that applies to a fill, depending on whether it was the maker. */
  rate(maker: boolean): number {
    return maker ? this.makerRate : this.takerRate;
  }

  /**
   * Commission charged on a fill, as a positive cost in the quote asset.
   * notional = Price × Quantity. Rounded to 8 decimals exactly as Binance does,
   * so this reproduces the export's "Fee" column (which is shown negative) to
   * the 8th decimal place.
   */
  feeFor(notional: number, opts: { maker?: boolean } = {}): number {
    const rate = this.rate(opts.maker ?? false);
    return Math.round(Math.abs(notional) * rate * 1e8) / 1e8;
  }
}
