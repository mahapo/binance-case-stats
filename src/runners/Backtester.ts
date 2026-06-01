import { OrderFutures } from "../models";
import { Recovery, RecoveryOptions, SeriesResult } from "../strategies";
import { Tick } from "../data/PriceLoader";

// Tick-driven backtester for the sequential Zone-Recovery strategy.
//
// Per tick: if no series is active, ask the strategy for a fresh signal; then
// settle the active order against the tick price — when it hits its take-profit
// or stop-loss the strategy reacts (close + reset, or open the next hedge) and
// the closed order's net PnL is booked to the running balance. A single tick may
// cross several zone lines (gap jump), so settlement loops until the active order
// no longer triggers.

export interface BacktestOptions extends RecoveryOptions {
  startBalance?: number;
}

export interface EquityPoint {
  time: number;
  balance: number;
}

export interface BacktestResult {
  startBalance: number;
  balance: number;
  totalPnL: number; // balance − startBalance (net, fees included)
  grossProfit: number; // Σ closed order.profit
  totalFees: number; // Σ closed order.feeRoundTrip
  seriesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number; // fraction 0..1
  maxStepReached: number;
  maxDrawdown: number; // largest peak-to-trough drop in balance
  orders: OrderFutures[];
  series: SeriesResult[];
  equity: EquityPoint[];
}

export class Backtester {
  strategy!: Recovery;
  balance = 0;
  equity: EquityPoint[] = [];

  run(options: BacktestOptions, ticks: Tick[]): BacktestResult {
    const startBalance = options.startBalance ?? 1000;
    this.strategy = new Recovery(options);
    this.balance = startBalance;
    this.equity = [];

    for (const tick of ticks) this.onTick(tick);

    return this.finish(startBalance);
  }

  private onTick(tick: Tick): void {
    if (!this.strategy.hasActiveSeries) {
      // Size the next series off the live balance (risk-% sizing compounds).
      this.strategy.onSignal(tick.price, tick.time, this.balance);
    }
    this.settle(tick);
  }

  private settle(tick: Tick): void {
    let guard = 0;
    while (this.strategy.hasActiveSeries && guard++ < 10_000) {
      const order = this.strategy.currentOrder;
      if (!order || order.status !== "open" || order.filled === 0) break;

      const tp = order.checkIfTriggersTakeProfit(tick.price);
      const sl = order.checkIfTriggersStopLoss(tick.price);
      if (!tp && !sl) break;

      if (tp) this.strategy.onTakeProfit(order);
      else this.strategy.onStopLoss(order);

      // `order` is now closed with its exit price set; book its net PnL.
      this.balance += order.pnl;
      this.equity.push({ time: tick.time, balance: this.balance });
    }
  }

  private finish(startBalance: number): BacktestResult {
    // Account every closed order, including the already-realized legs of a series
    // still in progress when the ticks ran out (otherwise the balance, which was
    // booked tick-by-tick, would not reconcile with the reported totals).
    const allOrders = [...this.strategy.orders, ...this.strategy.currentOrders];
    const closed = allOrders.filter((o) => o.status === "closed");
    const grossProfit = closed.reduce((s, o) => s + o.profit, 0);
    const totalFees = closed.reduce((s, o) => s + o.feeRoundTrip, 0);

    // Max drawdown from the equity curve.
    let peak = startBalance;
    let maxDrawdown = 0;
    for (const p of this.equity) {
      if (p.balance > peak) peak = p.balance;
      maxDrawdown = Math.max(maxDrawdown, peak - p.balance);
    }

    const { seriesCount, winCount, lossCount, maxStepReached } =
      this.strategy.stats;

    return {
      startBalance,
      balance: this.balance,
      totalPnL: this.balance - startBalance,
      grossProfit,
      totalFees,
      seriesCount,
      winCount,
      lossCount,
      winRate: seriesCount > 0 ? winCount / seriesCount : 0,
      maxStepReached,
      maxDrawdown,
      orders: allOrders,
      series: this.strategy.series,
      equity: this.equity,
    };
  }
}
