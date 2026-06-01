import { OrderFutures, FeeSchedule } from "../models";
import { StrategyBase } from "./StrategyBase";
import { ZoneRecovery, Side } from "./ZoneRecovery";

// Sequential Zone-Recovery hedging strategy.
//
// On a signal it opens a random long/short and builds the recovery grid. While a
// series is active exactly ONE order is filled at a time: when it hits its
// stop-loss it closes (the loss is realized) and the next, larger, opposite
// order opens at that line; when any order hits its take-profit the whole series
// closes for the constant gross target and resets.
//
// `maxSteps` caps the number of hedge orders. When the cap is reached:
//   - "take-loss"  (default): the final stop-loss realizes the full cumulative
//     loss — the honest martingale-ruin outcome.
//   - "breakeven": the final order's take-profit is pulled in to the exact
//     series break-even price, so a small recovery closes the series flat
//     instead of chasing the full target (CAP EA "breakeven safety").

export type LossTakingPolicy = "take-loss" | "breakeven";

export interface RecoveryOptions {
  symbol: string;
  ratio: number;
  leverage: number;
  /** Stop-loss distance as a leverage-adjusted % of price (TP = ratio × this). */
  gapPercent: number;
  /**
   * Base (step-0) size as a fixed base-asset quantity. Provide this OR
   * `riskPercent`. When `riskPercent` is set it takes precedence and the size is
   * recomputed from the live balance at each new series.
   */
  baseQuantity?: number;
  /**
   * Size the base (step-0) order's margin as this percent of the current balance
   * (e.g. 1–2). notional = margin × leverage, quantity = notional / price. The
   * size compounds as the balance changes between series.
   */
  riskPercent?: number;
  maxSteps: number;
  lossTakingPolicy?: LossTakingPolicy;
  feeSchedule?: FeeSchedule;
  /** Fee tier used when `feeSchedule` is not supplied (Regular User = 0). */
  vipLevel?: number;
  maker?: boolean;
  /** RNG for the initial side (injectable for deterministic tests). */
  rng?: () => number;
  /** Force the initial side (overrides rng); handy for tests. */
  forceSide?: Side;
}

export interface SeriesResult {
  seriesId: number;
  outcome: "win" | "loss";
  steps: number; // orders filled in the series
  grossProfit: number; // Σ order.profit
  fees: number; // Σ order.fee (round-trip)
  netProfit: number; // grossProfit − fees
}

export class Recovery extends StrategyBase {
  static id = "zone-recovery";

  readonly options: RecoveryOptions & {
    lossTakingPolicy: LossTakingPolicy;
    feeSchedule: FeeSchedule;
    maker: boolean;
    rng: () => number;
  };

  currentOrder: OrderFutures | null = null;
  zone: ZoneRecovery | null = null;
  side: Side = "buy";

  private seriesCounter = 0;
  private stepIndex = 0;

  /** Per-series summaries, pushed as each series completes. */
  series: SeriesResult[] = [];

  stats = {
    maxStepReached: 0,
    seriesCount: 0,
    winCount: 0,
    lossCount: 0,
  };

  constructor(options: RecoveryOptions) {
    super();
    if (options.baseQuantity == null && options.riskPercent == null) {
      throw new Error("provide baseQuantity or riskPercent");
    }
    this.options = {
      lossTakingPolicy: "take-loss",
      feeSchedule: options.feeSchedule ?? FeeSchedule.vip(options.vipLevel ?? 0),
      maker: false,
      rng: Math.random,
      forceSide: options.forceSide,
      ...options,
    };
  }

  /**
   * Base-asset quantity of the step-0 order. With `riskPercent` the order's
   * margin is that percent of the live balance (notional = margin × leverage);
   * otherwise the fixed `baseQuantity` is used.
   */
  private resolveBaseQuantity(price: number, balance: number): number {
    if (this.options.riskPercent != null) {
      const margin = (this.options.riskPercent / 100) * balance;
      return (margin * this.options.leverage) / price;
    }
    return this.options.baseQuantity as number;
  }

  // ---- Hooks ----

  onSignal(price: number, timestamp: number, balance = 0): void {
    this.side =
      this.options.forceSide ?? (this.options.rng() < 0.5 ? "buy" : "sell");

    this.zone = new ZoneRecovery({
      entryPrice: price,
      side: this.side,
      symbol: this.options.symbol,
      ratio: this.options.ratio,
      leverage: this.options.leverage,
      gapPercent: this.options.gapPercent,
      baseQuantity: this.resolveBaseQuantity(price, balance),
      feeSchedule: this.options.feeSchedule,
      maker: this.options.maker,
    });

    this.currentOrders = this.zone.buildOrders(
      this.options.maxSteps,
      timestamp,
      this.seriesCounter
    );

    if (this.options.lossTakingPolicy === "breakeven") {
      this.applyBreakevenFinalTakeProfit();
    }

    this.stepIndex = 0;
    this.fillOrder(this.currentOrders[0], timestamp);
    this.currentOrder = this.currentOrders[0];
  }

  onOrderFilled(order: OrderFutures): void {
    this.currentOrder = order;
  }

  onStopLoss(order: OrderFutures): void {
    this.closeOrder(order, order.stopLoss!);

    const nextIndex = this.stepIndex + 1;
    if (nextIndex < this.currentOrders.length) {
      // Open and immediately fill the next, larger, opposite hedge at this line.
      this.stepIndex = nextIndex;
      const next = this.currentOrders[nextIndex];
      this.fillOrder(next, order.timestampExit ?? order.timestamp);
      this.currentOrder = next;
      this.stats.maxStepReached = Math.max(
        this.stats.maxStepReached,
        nextIndex + 1
      );
    } else {
      // Max hedge orders reached and the final leg lost: realize the full loss.
      this.finishSeries("loss");
    }
  }

  onTakeProfit(order: OrderFutures): void {
    this.closeOrder(order, order.takeProfit!);
    this.finishSeries("win");
  }

  // ---- Internals ----

  private fillOrder(order: OrderFutures, timestamp: number): void {
    order.status = "open";
    order.filled = order.quantity;
    order.timestampFilled = timestamp;
    this.stats.maxStepReached = Math.max(
      this.stats.maxStepReached,
      this.stepIndex + 1
    );
  }

  private closeOrder(order: OrderFutures, priceExit: number): void {
    order.status = "closed";
    order.priceExit = priceExit;
    order.timestampExit = order.timestampExit ?? order.timestampFilled;
  }

  private finishSeries(outcome: "win" | "loss"): void {
    // Cancel any unopened grid orders.
    for (const o of this.currentOrders) {
      if (o.status === "pending") o.status = "canceled";
    }

    const filled = this.currentOrders.filter((o) => o.status === "closed");
    const grossProfit = filled.reduce((s, o) => s + o.profit, 0);
    const fees = filled.reduce((s, o) => s + o.feeRoundTrip, 0);

    this.series.push({
      seriesId: this.seriesCounter,
      outcome,
      steps: filled.length,
      grossProfit,
      fees,
      netProfit: grossProfit - fees,
    });

    this.stats.seriesCount++;
    if (outcome === "win") this.stats.winCount++;
    else this.stats.lossCount++;

    this.orders.push(...this.currentOrders.filter((o) => o.status !== "pending"));
    this.currentOrders = [];
    this.currentOrder = null;
    this.zone = null;
    this.stepIndex = 0;
    this.seriesCounter++;
  }

  /**
   * Pull the final order's take-profit in to the exact series break-even price,
   * where the final leg's profit cancels every prior step's loss.
   */
  private applyBreakevenFinalTakeProfit(): void {
    const last = this.currentOrders.length - 1;
    if (last < 1 || !this.zone) return;

    const gap = this.zone.gap;
    let priorLossQty = 0;
    for (let i = 0; i < last; i++) priorLossQty += this.zone.quantityAt(i);

    const finalOrder = this.currentOrders[last];
    const distance = (gap * priorLossQty) / finalOrder.quantity;
    finalOrder.takeProfit =
      finalOrder.side === "buy"
        ? finalOrder.price + distance
        : finalOrder.price - distance;
  }
}
