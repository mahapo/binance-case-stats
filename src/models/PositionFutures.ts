import { FeeSchedule } from "./FeeSchedule";

// Reconstructs a Binance USDⓈ-M futures position from a stream of fills and
// computes Realized Profit and commission exactly as the exchange does.
//
// Realized Profit on USDⓈ-M is a weighted-average-cost model:
//   - A fill on the same side as the open position (or opening from flat)
//     does NOT realize profit; it only updates the average entry price.
//   - A fill on the opposite side REDUCES the position and realizes:
//         realized = closedQty × (fillPrice − avgEntry) × direction
//     where direction = +1 for a long being reduced, −1 for a short.
//   - If a reducing fill is larger than the open position it FLIPS: the
//     position closes (realizing on the closed part) and a new opposite
//     position opens at the fill price for the remainder.
//
// This matches Binance's "Realized Profit" column to the cent across every
// closed position cycle in the real trade exports (verified in the tests).
// Fees are tracked separately (Binance does not fold commission into Realized
// Profit); net = realizedProfit − totalFee.

const EPS = 1e-9;

export type FillSide = "buy" | "sell" | "BUY" | "SELL";

export interface Fill {
  price: number;
  quantity: number;
  side: FillSide;
  /** true if this fill was the maker (resting order). Defaults to false (taker). */
  maker?: boolean;
  timestamp?: number;
}

export interface FillResult {
  /** Realized profit booked by this fill (0 when only opening/increasing). */
  realizedProfit: number;
  /** Commission charged on this fill, as a positive cost. */
  fee: number;
  /** Signed position size after the fill (+ long, − short). */
  netQty: number;
  /** Average entry price after the fill (0 when flat). */
  avgEntryPrice: number;
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const toSignedQty = (side: FillSide, qty: number) =>
  (String(side).toUpperCase() === "BUY" ? 1 : -1) * Math.abs(qty);

export class PositionFutures {
  /** Signed position size: positive = long, negative = short, 0 = flat. */
  netQty = 0;
  /** Weighted-average entry price of the open position (0 when flat). */
  avgEntryPrice = 0;
  /** Cumulative realized profit (Binance "Realized Profit"), fees excluded. */
  realizedProfit = 0;
  /** Cumulative commission paid, as a positive cost. */
  totalFee = 0;

  constructor(
    public symbol: string,
    public feeSchedule: FeeSchedule = new FeeSchedule()
  ) {}

  get side(): "long" | "short" | "flat" {
    if (this.netQty > EPS) return "long";
    if (this.netQty < -EPS) return "short";
    return "flat";
  }

  get isOpen(): boolean {
    return Math.abs(this.netQty) > EPS;
  }

  /** Notional value of the open position at its average entry price. */
  get notional(): number {
    return Math.abs(this.netQty) * this.avgEntryPrice;
  }

  /** Realized profit net of all commission paid so far. */
  get netRealized(): number {
    return this.realizedProfit - this.totalFee;
  }

  /** Mark-to-market unrealized PnL of the open position at a given price. */
  unrealizedPnl(markPrice: number): number {
    if (!this.isOpen) return 0;
    return (markPrice - this.avgEntryPrice) * this.netQty;
  }

  /**
   * Apply one fill, mutating the position. Returns what this fill realized and
   * cost in fees, plus the resulting position state.
   */
  applyFill(fill: Fill): FillResult {
    const q = toSignedQty(fill.side, fill.quantity);
    const prev = this.netQty;
    let realized = 0;

    if (prev === 0 || sign(q) === sign(prev)) {
      // Opening from flat or increasing the position: update average entry.
      const prevAbs = Math.abs(prev);
      const addAbs = Math.abs(q);
      this.avgEntryPrice =
        (this.avgEntryPrice * prevAbs + fill.price * addAbs) / (prevAbs + addAbs);
      this.netQty = prev + q;
    } else {
      // Reducing / closing / flipping the position.
      const closeQty = Math.min(Math.abs(q), Math.abs(prev));
      realized = closeQty * (fill.price - this.avgEntryPrice) * sign(prev);
      this.netQty = prev + q;

      if (Math.abs(q) > Math.abs(prev) + EPS) {
        // Flipped past flat: remainder opens a new position at the fill price.
        this.avgEntryPrice = fill.price;
      } else if (Math.abs(this.netQty) < EPS) {
        // Back to flat.
        this.netQty = 0;
        this.avgEntryPrice = 0;
      }
      // Pure reduction (no flip, still open): average entry is unchanged.
    }

    const fee = this.feeSchedule.feeFor(fill.price * Math.abs(fill.quantity), {
      maker: fill.maker,
    });

    this.realizedProfit += realized;
    this.totalFee += fee;

    return {
      realizedProfit: realized,
      fee,
      netQty: this.netQty,
      avgEntryPrice: this.avgEntryPrice,
    };
  }

  /** Reset to flat. Cumulative realizedProfit / totalFee are preserved. */
  reset(): void {
    this.netQty = 0;
    this.avgEntryPrice = 0;
  }

  /** Build a position by replaying fills in order. */
  static fromFills(
    symbol: string,
    fills: Fill[],
    feeSchedule?: FeeSchedule
  ): PositionFutures {
    const pos = new PositionFutures(symbol, feeSchedule);
    for (const f of fills) pos.applyFill(f);
    return pos;
  }
}
