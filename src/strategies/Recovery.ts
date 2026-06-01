import { OrderFutures, FeeSchedule, LeverageBracket } from "../models";
import { mulberry32 } from "../utils/rng";
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
   * Sizing — provide exactly one of `maxDrawdownPercent`, `riskPercent` or
   * `baseQuantity` (precedence in that order). All are recomputed per series and
   * then capped so the largest (last) hedge stays within the leverage's position
   * bracket.
   *
   * `maxDrawdownPercent`: the size is derived from the maximum hedge step so that
   * a fully-lost series (all `maxSteps` stop-losses) costs exactly this percent
   * of the live balance — i.e. the worst-case drawdown. This keeps the balance
   * from ever going negative. e.g. 20–40.
   */
  maxDrawdownPercent?: number;
  /** Step-0 margin as a % of balance (notional = margin × leverage). */
  riskPercent?: number;
  /** Fixed step-0 base-asset quantity. */
  baseQuantity?: number;
  maxSteps: number;
  lossTakingPolicy?: LossTakingPolicy;
  feeSchedule?: FeeSchedule;
  /** Fee tier used when `feeSchedule` is not supplied (Regular User = 0). */
  vipLevel?: number;
  /** Position-limit brackets used to cap the last hedge (default BTCUSDT). */
  leverageBracket?: LeverageBracket;
  maker?: boolean;
  /** RNG for the initial side (injectable for deterministic tests). */
  rng?: () => number;
  /** Seed for a reproducible random side (used when no `rng`/`forceSide`). */
  seed?: number;
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
    leverageBracket: LeverageBracket;
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
    if (
      options.maxDrawdownPercent == null &&
      options.riskPercent == null &&
      options.baseQuantity == null
    ) {
      throw new Error(
        "provide maxDrawdownPercent, riskPercent or baseQuantity"
      );
    }
    // Spread first, then resolve managed fields with ?? so an explicit
    // `undefined` (e.g. feeSchedule) still falls back to its default.
    this.options = {
      ...options,
      lossTakingPolicy: options.lossTakingPolicy ?? "take-loss",
      feeSchedule: options.feeSchedule ?? FeeSchedule.vip(options.vipLevel ?? 0),
      leverageBracket: options.leverageBracket ?? new LeverageBracket(),
      maker: options.maker ?? false,
      rng:
        options.rng ??
        (options.seed != null ? mulberry32(options.seed) : Math.random),
    };
  }

  /** Size multiplier per recovery step: M = 1 + 1/ratio. */
  private get multiplier(): number {
    return 1 + 1 / this.options.ratio;
  }

  /**
   * Base-asset quantity of the step-0 order, then capped so the largest (last)
   * hedge stays within the leverage's position bracket.
   *   - maxDrawdownPercent: derive the size from the max hedge step so a
   *     fully-lost series costs exactly that percent of balance.
   *   - riskPercent: step-0 margin = that percent of balance.
   *   - baseQuantity: fixed.
   */
  private resolveBaseQuantity(
    price: number,
    balance: number,
    side: Side
  ): number {
    const { leverage, maxSteps, gapPercent } = this.options;
    const M = this.multiplier;
    const gap = (gapPercent / 100 / leverage) * price;

    let baseQty: number;
    if (this.options.maxDrawdownPercent != null) {
      // Worst-case series loss = gap × Σ qᵢ = gap × baseQty × Σ Mⁱ.
      const sumFactors = (Math.pow(M, maxSteps) - 1) / (M - 1);
      const worstLossPerQty = gap * sumFactors;
      baseQty =
        worstLossPerQty > 0
          ? ((this.options.maxDrawdownPercent / 100) * balance) / worstLossPerQty
          : 0;
    } else if (this.options.riskPercent != null) {
      const margin = (this.options.riskPercent / 100) * balance;
      baseQty = (margin * leverage) / price;
    } else {
      baseQty = this.options.baseQuantity as number;
    }

    // Cap so the last (biggest) hedge's notional ≤ the leverage's bracket limit.
    // Entries alternate between the two zone lines, so the last step's entry is
    // one gap off the signal price on odd steps.
    const lastIdx = maxSteps - 1;
    const oddLast = lastIdx % 2 === 1;
    const entryLast = !oddLast
      ? price
      : side === "buy"
        ? price - gap
        : price + gap;
    const maxPositionValue =
      this.options.leverageBracket.maxPositionValue(leverage);
    const maxBaseQty = maxPositionValue / (Math.pow(M, lastIdx) * entryLast);

    return Math.max(0, Math.min(baseQty, maxBaseQty));
  }

  // ---- Hooks ----

  onSignal(price: number, timestamp: number, balance = 0): void {
    const side =
      this.options.forceSide ?? (this.options.rng() < 0.5 ? "buy" : "sell");

    const baseQuantity = this.resolveBaseQuantity(price, balance, side);
    // No affordable / bracket-allowed size → don't open a series.
    if (!(baseQuantity > 0)) return;

    this.side = side;
    this.zone = new ZoneRecovery({
      entryPrice: price,
      side: this.side,
      symbol: this.options.symbol,
      ratio: this.options.ratio,
      leverage: this.options.leverage,
      gapPercent: this.options.gapPercent,
      baseQuantity,
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
