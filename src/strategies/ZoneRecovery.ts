import { OrderFutures, FeeSchedule } from "../models";

// Pure Zone-Recovery geometry + sizing (no I/O, no price feed).
//
// The recovery grid lives between two horizontal lines a fixed `gap` apart.
// Starting from an initial side, every step's entry is the previous step's
// stop-loss, so entries alternate between the two lines (A, B=A−gap, A, B, …).
// Each step is sized geometrically so that — in the SEQUENTIAL model where one
// order is active at a time — the series nets a CONSTANT gross profit whenever a
// take-profit closes it, regardless of how many recovery steps it took.
//
// Convention: `ratio` = reward:risk = take-profit distance ÷ gap.
//   - stop-loss distance = gap, take-profit distance = ratio × gap
//   - size multiplier per step  M = 1 + 1/ratio
//   - gross profit per completed series = ratio × gap × baseQuantity   (constant)
//   - ratio = 1 ⇒ sizes double (1,2,4,8,…), TP = 1 gap  (the CAP Zone Recovery EA diagram)
//
// The gap is a fixed PRICE distance computed once from the initial price, so the
// two lines stay exactly `gap` apart across all steps and the invariant is exact.

export type Side = "buy" | "sell";

export interface ZoneRecoveryOptions {
  entryPrice: number;
  side: Side;
  symbol: string;
  /** Reward:risk = TP distance / gap. Must be > 0. */
  ratio: number;
  leverage: number;
  /**
   * Stop-loss distance as a leverage-adjusted percentage of the entry price:
   *   gap (price) = (gapPercent / 100 / leverage) × entryPrice
   * e.g. leverage 100, gapPercent 20 → a 0.20% price move is one gap (a "20% SL"
   * in margin terms). The take-profit sits `ratio × gapPercent` away, so at
   * ratio 2 a 20% SL pairs with a 40% TP.
   */
  gapPercent: number;
  /** Base-asset quantity of the first (step-0) order. */
  baseQuantity: number;
  feeSchedule?: FeeSchedule;
  maker?: boolean;
}

export class ZoneRecovery {
  readonly entryPrice: number;
  readonly side: Side;
  readonly symbol: string;
  readonly ratio: number;
  readonly leverage: number;
  readonly gapPercent: number;
  readonly baseQuantity: number;
  readonly feeSchedule: FeeSchedule;
  readonly maker: boolean;

  /** Fixed price distance of one gap (stop-loss distance). */
  readonly gap: number;

  constructor(options: ZoneRecoveryOptions) {
    if (options.ratio <= 0) throw new Error("ratio must be > 0");
    this.entryPrice = options.entryPrice;
    this.side = options.side;
    this.symbol = options.symbol;
    this.ratio = options.ratio;
    this.leverage = options.leverage;
    this.gapPercent = options.gapPercent;
    this.baseQuantity = options.baseQuantity;
    this.feeSchedule = options.feeSchedule ?? new FeeSchedule();
    this.maker = options.maker ?? false;

    this.gap = (this.gapPercent / 100 / this.leverage) * this.entryPrice;
    if (!(this.gap > 0)) {
      throw new Error("gapPercent must produce a gap > 0");
    }
  }

  /** Size multiplier per recovery step: M = 1 + 1/ratio. */
  get multiplier(): number {
    return 1 + 1 / this.ratio;
  }

  /** Base-asset quantity of step `i` (0-indexed): baseQuantity × M^i. */
  quantityAt(i: number): number {
    return this.baseQuantity * Math.pow(this.multiplier, i);
  }

  /** Constant gross profit a completed series yields: ratio × gap × baseQuantity. */
  get seriesGrossTarget(): number {
    return this.ratio * this.gap * this.baseQuantity;
  }

  /**
   * Build the full grid of `count` orders. Each order has its exact entry,
   * stop-loss and take-profit set. Sizing is by base quantity (not notional),
   * which is what makes the gross-profit invariant exact.
   */
  buildOrders(count: number, timestamp = 0, seriesId?: string | number): OrderFutures[] {
    const orders: OrderFutures[] = [];
    let entry = this.entryPrice;

    for (let i = 0; i < count; i++) {
      // Step 0 keeps the initial side; subsequent steps alternate.
      const side: Side =
        i % 2 === 0 ? this.side : this.side === "buy" ? "sell" : "buy";

      const stopLoss = side === "buy" ? entry - this.gap : entry + this.gap;
      const takeProfit =
        side === "buy"
          ? entry + this.ratio * this.gap
          : entry - this.ratio * this.gap;

      const order = new OrderFutures(
        {
          price: entry,
          quantity: this.quantityAt(i),
          side,
          symbol: this.symbol,
          leverage: this.leverage,
          ratio: this.ratio,
          timestamp,
          feeSchedule: this.feeSchedule,
          maker: this.maker,
          stopLoss,
          takeProfit,
        },
        String(seriesId ?? "")
      );
      order.seriesId = seriesId;
      orders.push(order);

      // The next step enters at this step's stop-loss line.
      entry = stopLoss;
    }

    return orders;
  }
}
