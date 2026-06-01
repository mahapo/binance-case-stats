import { OrderFutures } from "../models";

// Minimal strategy contract the Backtester drives. A strategy reacts to the
// price feed through the lifecycle hooks below and accumulates its finished
// orders in `orders` for post-run statistics.
export abstract class StrategyBase {
  static id = "base";

  /** All orders the strategy has finished with (closed or canceled). */
  orders: OrderFutures[] = [];

  /** Orders currently live in the active series (open or pending). */
  currentOrders: OrderFutures[] = [];

  get activeOrders(): OrderFutures[] {
    return this.currentOrders.filter((o) => o.status === "open");
  }

  /** Net realized PnL (profit − fees) across every order seen so far. */
  get profitTotal(): number {
    return [...this.orders, ...this.currentOrders].reduce(
      (sum, o) => sum + (o.status === "closed" ? o.pnl : 0),
      0
    );
  }

  // ---- Lifecycle hooks (overridden by concrete strategies) ----

  /** Called when there is no active series and a new entry should be opened. */
  abstract onSignal(price: number, timestamp: number, balance?: number): void;

  /** Called once an open order has been filled at `price`. */
  abstract onOrderFilled(order: OrderFutures): void;

  /** Called when a filled order's stop-loss is hit. */
  abstract onStopLoss(order: OrderFutures): void;

  /** Called when a filled order's take-profit is hit. */
  abstract onTakeProfit(order: OrderFutures): void;

  /** True while a recovery series is in progress. */
  get hasActiveSeries(): boolean {
    return this.currentOrders.length > 0;
  }
}
