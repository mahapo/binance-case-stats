import colors from "colors/safe";
import { FeeSchedule } from "./FeeSchedule";

// A single Binance USDⓈ-M futures order / fill.
//
// This models one execution (and the planning data around it: leverage, stop
// loss, take profit) and computes the per-order figures Binance shows on the
// order ticket and in the trade history:
//   - notional / quantity / initial margin
//   - mark-to-market profit and ROI versus an exit price
//   - commission (via a configurable FeeSchedule)
//   - target price, liquidation price and break-even price
//
// Authoritative *realized* profit across a sequence of fills is computed by
// PositionFutures — this class is the single-fill building block that feeds it.
//
// USDⓈ-Margined formulae (per Binance docs):
//   Initial Margin = Notional / Leverage            (Notional = Quantity × Price)
//   Long  PnL = (Exit − Entry) × Quantity
//   Short PnL = (Entry − Exit) × Quantity
//   ROI       = PnL / Initial Margin

export type OrderSide = "buy" | "sell";

export interface OrderFuturesOptions {
  price: number;
  side: string;
  symbol: string;
  timestamp?: number;

  // Size: provide exactly one of the following.
  quantity?: number; // base-asset quantity (e.g. BTC)
  amount?: number; // notional value in quote (legacy: Quantity × Price)
  amountUsd?: number; // notional value in quote (legacy alias)

  leverage?: number;
  margin?: number;

  maker?: boolean; // true if this order was/would be the maker. Default taker.
  feeSchedule?: FeeSchedule;

  stopLoss?: number;
  takeProfit?: number;
  ratio?: number;
  amountLoss?: number;
  closePosition?: boolean;
  reduceOnly?: boolean;
  postOnly?: boolean;
  clientOrderId?: string;
}

export class OrderFutures {
  symbol: string;
  side: OrderSide;
  timestamp: number;

  price: number; // entry price
  priceExit: number; // exit / mark price (defaults to entry)

  quantity: number; // base-asset quantity
  amount: number; // notional value (quantity × price) in quote asset
  amountUsd: number; // alias of notional, kept for backward compatibility

  leverage: number;
  margin: number;

  maker: boolean;
  feeSchedule: FeeSchedule;

  stopLoss?: number;
  takeProfit?: number;
  ratio?: number;
  amountLoss?: number;
  closePosition = false;
  reduceOnly = false;
  postOnly = false;
  clientOrderId?: string;

  // Trailing-stop support (used by the backtester).
  callbackRate = 0.001;
  priceActivation?: number;
  maxLossPercent = 50;

  // ---- Lifecycle state (driven by the backtester) ----
  status: "pending" | "open" | "closed" | "canceled" = "pending";
  filled = 0; // filled quantity (base asset); 0 = unfilled
  timestampFilled?: number;
  timestampExit?: number;
  /** Identifier of the recovery series this order belongs to (set by the strategy). */
  seriesId?: string | number;

  constructor(options: OrderFuturesOptions, public slug = "") {
    if (
      options.quantity == null &&
      options.amount == null &&
      options.amountUsd == null
    ) {
      throw new Error("quantity, amount or amountUsd missing");
    }

    this.symbol = options.symbol;
    this.side = options.side.toLowerCase() as OrderSide;
    this.timestamp = options.timestamp ?? Date.now();

    // Keep the entry price exact. (Binance applies a per-symbol tick size, not a
    // fixed 2-decimal round; flooring here would corrupt sub-dollar alts and break
    // the exact zone-recovery PnL invariant. Callers round to tick size if needed.)
    this.price = options.price;
    this.priceExit = options.price;

    this.leverage = options.leverage ?? 1;

    // Resolve size into a single source of truth: quantity + notional.
    if (options.quantity != null) {
      this.quantity = options.quantity;
      this.amount = options.quantity * this.price;
    } else {
      // amount / amountUsd are notional values.
      const notional = (options.amount ?? options.amountUsd) as number;
      this.amount = notional;
      this.quantity = this.price > 0 ? notional / this.price : 0;
    }
    this.amountUsd = this.amount;
    this.margin = options.margin ?? this.amount / this.leverage;

    this.maker = options.maker ?? false;
    this.feeSchedule = options.feeSchedule ?? new FeeSchedule();

    this.stopLoss = options.stopLoss;
    this.takeProfit = options.takeProfit;
    this.ratio = options.ratio;
    this.amountLoss = options.amountLoss;
    this.clientOrderId = options.clientOrderId;

    this.closePosition = options.closePosition ?? false;
    this.reduceOnly = options.reduceOnly ?? false;
    this.postOnly = options.postOnly ?? false;
  }

  // ---- Size / margin -------------------------------------------------------

  /** Notional value = Quantity × Entry Price. */
  get notional(): number {
    return this.amount;
  }

  /** Initial Margin = Notional / Leverage. */
  get initialMargin(): number {
    return this.amount / this.leverage;
  }

  // ---- Profit / ROI --------------------------------------------------------

  /** Mark-to-market profit versus priceExit (gross, fees excluded). */
  get profit(): number {
    const direction = this.side === "buy" ? 1 : -1;
    return (this.priceExit - this.price) * this.quantity * direction;
  }

  /** ROI = profit / initial margin (gross, as per the Binance calculator). */
  get roi(): number {
    return this.profit / this.initialMargin;
  }

  /** Net profit after round-trip (entry + exit) commission. */
  get pnl(): number {
    return this.profit - this.feeRoundTrip;
  }

  get winTrade(): boolean {
    return this.side === "buy"
      ? this.priceExit >= this.price
      : this.priceExit <= this.price;
  }

  // ---- Fees ----------------------------------------------------------------

  /** Commission for this single fill (positive cost) from the fee schedule. */
  get fee(): number {
    return this.feeSchedule.feeFor(this.amount, { maker: this.maker });
  }

  /** Backward-compatible alias for {@link fee}. */
  get fees(): number {
    return this.fee;
  }

  /** Round-trip commission (entry + exit), assuming the same maker/taker side. */
  get feeRoundTrip(): number {
    const exitNotional = this.priceExit * this.quantity;
    return this.fee + this.feeSchedule.feeFor(exitNotional, { maker: this.maker });
  }

  // ---- Price targets -------------------------------------------------------

  /** Target price for a given ROI (decimal, e.g. 1.0 = 100%). */
  calculateTargetPrice(roi: number): number {
    const target =
      this.side === "buy"
        ? this.price * (1 + roi / this.leverage)
        : this.price * (1 - roi / this.leverage);
    // Binance truncates (floors) the displayed target price.
    return Math.floor(target * 100) / 100;
  }

  /**
   * Liquidation price (One-Way mode) for a given wallet balance.
   *   Long:  (Notional − Balance) / (Qty × (1 − MMR))
   *   Short: (Notional + Balance) / (Qty × (1 + MMR))
   */
  calculateLiquidationPrice(
    balance: number,
    maintenanceMarginRate = 0.004
  ): number {
    const qty = this.quantity;
    const liq =
      this.side === "buy"
        ? (this.amount - balance) / (qty * (1 - maintenanceMarginRate))
        : (this.amount + balance) / (qty * (1 + maintenanceMarginRate));
    return Number(liq.toFixed(2));
  }

  /** Maximum open quantity affordable for a balance: Balance × Leverage / Price. */
  calculateMaxOpenQuantity(balance: number): number {
    return (balance * this.leverage) / this.price;
  }

  /**
   * Break-even price: where gross profit covers entry + exit commission.
   * Uses the maker rate on both legs (matches Binance's break-even display).
   *   Long:  Entry × (1 + 2 × makerRate)
   *   Short: Entry × (1 − 2 × makerRate)
   */
  get breakEvenPrice(): number {
    const combined = this.feeSchedule.makerRate * 2;
    const be =
      this.side === "buy"
        ? this.price * (1 + combined)
        : this.price * (1 - combined);
    return Math.floor(be * 100) / 100;
  }

  // ---- Order lifecycle helpers (used by the backtester) --------------------

  checkIfFilled(price: number): boolean {
    return (
      (this.side === "buy" && this.price <= price) ||
      (this.side === "sell" && this.price >= price)
    );
  }

  checkIfTriggersTakeProfit(price: number): boolean {
    if (this.priceActivation || this.takeProfit == null) return false;
    return (
      (this.side === "buy" && this.takeProfit <= price) ||
      (this.side === "sell" && this.takeProfit >= price)
    );
  }

  checkIfTriggersStopLoss(price: number): boolean {
    if (this.stopLoss == null) return false;
    return (
      (this.side === "buy" && this.stopLoss >= price) ||
      (this.side === "sell" && this.stopLoss <= price)
    );
  }

  // ---- Statics -------------------------------------------------------------

  /** Volume-weighted average entry price across orders. */
  static calculateAveragePrice(orders: OrderFutures[]): number {
    let totalNotional = 0;
    let totalQuantity = 0;
    for (const o of orders) {
      totalNotional += o.amount;
      totalQuantity += o.quantity;
    }
    return totalNotional / totalQuantity;
  }

  toString(): string {
    const tag = this.side === "buy" ? colors.green("L") : colors.red("S");
    return `${tag} ${this.symbol} ${this.quantity}@${this.price} (${this.amount.toFixed(
      2
    )}) lev:${this.leverage} TP:${this.takeProfit ?? "-"} SL:${
      this.stopLoss ?? "-"
    } BE:${this.breakEvenPrice.toFixed(2)}`;
  }
}
