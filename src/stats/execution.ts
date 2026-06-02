import { Order, Trade, Transaction } from "./load";
import { TradeUnit } from "./positions";

export interface ExecutionProfile {
  nOrders: number;
  typeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  typeStatus: Record<string, number>;
  stop: { total: number; filled: number; triggerRate: number };
  makerTaker: {
    makerFills: number;
    takerFills: number;
    makerFee: number;
    takerFee: number;
    takerFillShare: number;
    takerFeeShare: number;
  };
  exitTypes: Record<string, { n: number; wins: number; sumPnL: number; winRate: number; avgPnL: number }>;
  closingMatchedToOrders: number;
  closingTotal: number;
}

// ---------------------------------------------------------------------------
// Execution profile: order-type mix, fill status, stop-loss behaviour, maker/taker
// split, and how the closing (result-bearing) orders were exited.
// ---------------------------------------------------------------------------
export function executionProfile(
  trades: Trade[],
  orders: Order[],
  closing: TradeUnit[],
): ExecutionProfile {
  // Maker vs taker (from fills): market orders are takers and pay the higher fee.
  let makerFee = 0, takerFee = 0, makerFills = 0, takerFills = 0;
  for (const t of trades) {
    if (t.maker) {
      makerFee += Math.abs(t.fee);
      makerFills++;
    } else {
      takerFee += Math.abs(t.fee);
      takerFills++;
    }
  }

  const typeCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const typeStatus: Record<string, number> = {};
  const ordById = new Map<string, Order>();
  for (const o of orders) {
    typeCounts[o.type] = (typeCounts[o.type] || 0) + 1;
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    const k = `${o.type} / ${o.status}`;
    typeStatus[k] = (typeStatus[k] || 0) + 1;
    ordById.set(o.orderNo, o);
  }

  const isStop = (t: string): boolean => t === "STOP_MARKET" || t === "STOP";
  const stopTotal = orders.filter((o) => isStop(o.type)).length;
  const stopFilled = orders.filter((o) => isStop(o.type) && o.status === "FILLED").length;

  // How were the result-bearing positions exited?
  const exitTypes: ExecutionProfile["exitTypes"] = {};
  let matched = 0;
  for (const o of closing) {
    const ord = ordById.get(o.orderId!);
    const t = ord ? ord.type : "UNKNOWN";
    if (ord) matched++;
    if (!exitTypes[t]) exitTypes[t] = { n: 0, wins: 0, sumPnL: 0, winRate: 0, avgPnL: 0 };
    exitTypes[t].n++;
    if (o.realPnL > 0) exitTypes[t].wins++;
    exitTypes[t].sumPnL += o.realPnL;
  }
  for (const t of Object.keys(exitTypes)) {
    const e = exitTypes[t];
    e.winRate = e.n ? e.wins / e.n : 0;
    e.avgPnL = e.n ? e.sumPnL / e.n : 0;
  }

  return {
    nOrders: orders.length,
    typeCounts,
    statusCounts,
    typeStatus,
    stop: { total: stopTotal, filled: stopFilled, triggerRate: stopTotal ? stopFilled / stopTotal : 0 },
    makerTaker: {
      makerFills,
      takerFills,
      makerFee: -makerFee,
      takerFee: -takerFee,
      takerFillShare: makerFills + takerFills ? takerFills / (makerFills + takerFills) : 0,
      takerFeeShare: makerFee + takerFee ? takerFee / (makerFee + takerFee) : 0,
    },
    exitTypes,
    closingMatchedToOrders: matched,
    closingTotal: closing.length,
  };
}

export interface LiquidationProfile {
  count: number;
  total: number;
  byYear: Record<string, { count: number; total: number }>;
}

// Forced liquidations leave an INSURANCE_CLEAR footprint in the ledger.
export function liquidationProfile(transactions: Transaction[]): LiquidationProfile {
  const ins = transactions.filter((t) => t.type === "INSURANCE_CLEAR");
  const byYear: Record<string, { count: number; total: number }> = {};
  for (const t of ins) {
    const y = t.time.getUTCFullYear().toString();
    if (!byYear[y]) byYear[y] = { count: 0, total: 0 };
    byYear[y].count++;
    byYear[y].total += t.amount;
  }
  return { count: ins.length, total: ins.reduce((s, t) => s + t.amount, 0), byYear };
}
