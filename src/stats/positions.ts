import { Trade } from "./load";

// A "trade unit" for the outcome statistics — produced either by grouping fills
// into orders, or by reconstructing economic positions (open->flat cycles).
export interface TradeUnit {
  orderId?: string;
  symbol: string;
  time: Date;
  totalProfit?: number;
  totalFee?: number;
  realizedProfit?: number;
  fee?: number;
  realPnL: number;
  notional: number;
  nOrders?: number;
  hasRealizedProfit: boolean;
}

// ---------------------------------------------------------------------------
// Group fills by Order ID -> one order. A single closing order is often filled
// in many partial executions; grouping reproduces Binance's one-row-per-order
// ledger so that one order = one trade (not one fill).
// ---------------------------------------------------------------------------
export function groupByOrder(trades: Trade[]): TradeUnit[] {
  const orders = new Map<string, TradeUnit>();
  for (const t of trades) {
    if (!orders.has(t.orderId)) {
      orders.set(t.orderId, {
        orderId: t.orderId,
        symbol: t.symbol,
        time: t.time,
        totalProfit: 0,
        totalFee: 0,
        notional: 0,
        realPnL: 0,
        hasRealizedProfit: false,
      });
    }
    const o = orders.get(t.orderId)!;
    o.totalProfit! += t.realizedProfit;
    o.totalFee! += t.fee;
    o.notional += Math.abs(t.amount);
    if (t.realizedProfit !== 0) {
      o.hasRealizedProfit = true;
      o.time = t.time;
    }
  }
  const arr = Array.from(orders.values());
  for (const o of arr) o.realPnL = o.totalProfit! + o.totalFee!;
  return arr.sort((a, b) => a.time.getTime() - b.time.getTime());
}

// ---------------------------------------------------------------------------
// Reconstruct economic POSITIONS from fills. A single position is often closed
// across several orders (partial closes); counting orders would overstate
// consecutive same-sign outcomes. We rebuild open->flat cycles per symbol so
// that one economic position = one "trade" for the outcome statistics.
// ---------------------------------------------------------------------------
interface Cycle {
  symbol: string;
  rp: number;
  fee: number;
  time: Date;
  orderIds: Set<string>;
}

export function reconstructPositions(trades: Trade[]): TradeUnit[] {
  const bySym = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
    bySym.get(t.symbol)!.push(t); // trades are already globally time-sorted
  }
  const EPS = 1e-6;
  const finish = (c: Cycle): TradeUnit => ({
    symbol: c.symbol,
    time: c.time,
    realizedProfit: c.rp,
    fee: c.fee,
    realPnL: c.rp + c.fee,
    nOrders: c.orderIds.size,
    hasRealizedProfit: c.rp !== 0,
    notional: 0,
  });
  const positions: TradeUnit[] = [];
  for (const [sym, arr] of Array.from(bySym.entries())) {
    let net = 0;
    let cyc: Cycle | null = null;
    for (const f of arr) {
      const signed = (f.side === "BUY" ? 1 : -1) * f.quantity;
      const prev = net;
      net += signed;
      if (!cyc) cyc = { symbol: sym, rp: 0, fee: 0, time: f.time, orderIds: new Set() };
      cyc.rp += f.realizedProfit;
      cyc.fee += f.fee;
      cyc.time = f.time;
      cyc.orderIds.add(f.orderId);
      const flat = Math.abs(net) < EPS;
      const flip = prev !== 0 && Math.sign(net) !== Math.sign(prev) && !flat;
      if (flat) {
        positions.push(finish(cyc));
        net = 0;
        cyc = null;
      } else if (flip) {
        positions.push(finish(cyc)); // close + reopen
        cyc = null;
      }
    }
    if (cyc && cyc.rp !== 0) positions.push(finish(cyc));
  }
  return positions.sort((a, b) => a.time.getTime() - b.time.getTime());
}
