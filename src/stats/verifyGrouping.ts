#!/usr/bin/env ts-node
/**
 * Verification harness for the stats engine — proves that the fill -> order
 * grouping is correct and bullet-proof, by:
 *
 *   1) Drilling into specific Order IDs and showing every fill collapses into ONE order.
 *   2) Checking for Order-ID collisions (same ID across different symbols / far-apart times).
 *   3) Cross-validating the grouped order count + identity against Binance's OWN order
 *      records in account/futures/USD-M/orders/*.csv (one row = one order).
 *
 * Run:  npm run stats:verify              (runs all checks)
 *       npm run stats:verify -- 111147095130   (also deep-dives that Order ID)
 */
import { parseFee, readCsvDir } from "./csv";
import { parseAmount } from "./csv";
import { ORDERS_DIR, TRADES_DIR } from "./paths";

const num = (s: string | undefined): number => parseFee(s); // tolerant numeric (handles "x USDT")
const parseOrderDate = (s: string): number =>
  /^\d{4}-/.test(s)
    ? Date.parse(s + "Z")
    : Date.parse("20" + s.slice(0, 2) + "-" + s.slice(3, 5) + "-" + s.slice(6, 8) + "T" + s.slice(9) + "Z");

interface GroupedOrder {
  id: string;
  symbols: Set<string>;
  fills: number;
  qty: number;
  notional: number;
  realized: number;
  fee: number;
  tMin: number;
  tMax: number;
  realPnL: number;
  closing: boolean;
}

// ---- Load & group exactly like the engine ----
const tradeRows = readCsvDir(TRADES_DIR);
const orders = new Map<string, GroupedOrder>();
for (const r of tradeRows) {
  const id = r["Order Id"];
  if (!orders.has(id)) {
    orders.set(id, {
      id, symbols: new Set(), fills: 0, qty: 0, notional: 0,
      realized: 0, fee: 0, tMin: Infinity, tMax: -Infinity, realPnL: 0, closing: false,
    });
  }
  const o = orders.get(id)!;
  o.symbols.add(r["Symbol"]);
  o.fills++;
  o.qty += parseAmount(r["Quantity"]);
  o.notional += Math.abs(parseAmount(r["Amount"]));
  o.realized += parseAmount(r["Realized Profit"]);
  o.fee += num(r["Fee"]);
  const t = Date.parse(r["Time(UTC)"] + "Z");
  o.tMin = Math.min(o.tMin, t);
  o.tMax = Math.max(o.tMax, t);
}
for (const o of Array.from(orders.values())) {
  o.realPnL = o.realized + o.fee;
  o.closing = o.realized !== 0;
}

console.log(`Loaded ${tradeRows.length.toLocaleString()} fills -> ${orders.size.toLocaleString()} unique orders`);
const closing = Array.from(orders.values()).filter((o) => o.closing);
console.log(`  closing (result-bearing) orders: ${closing.length.toLocaleString()}`);
console.log(`  opening orders:                  ${(orders.size - closing.length).toLocaleString()}`);

// ---- Check 1: deep-dive specific Order IDs ----
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["111147095130", "11464316356"];
console.log("\n=== CHECK 1: specific Order IDs collapse into exactly ONE order ===");
for (const id of targets) {
  const o = orders.get(id);
  if (!o) {
    console.log(`  ${id}: NOT FOUND`);
    continue;
  }
  console.log(`  Order ${id}`);
  console.log(`    fills merged into this order : ${o.fills}`);
  console.log(`    distinct symbols             : ${Array.from(o.symbols).join(", ")}  (must be 1)`);
  console.log(`    summed quantity              : ${o.qty.toFixed(8)}`);
  console.log(`    summed realized profit       : ${o.realized.toFixed(8)}`);
  console.log(`    order realPnL                : ${o.realPnL.toFixed(4)}`);
  console.log(`    classified as                : ${o.closing ? (o.realPnL > 0 ? "WIN (1 trade)" : "LOSS (1 trade)") : "opening (not counted)"}`);
  console.log(`    => contributes ${o.closing ? 1 : 0} trade to win/loss stats (NOT ${o.fills})`);
}

// ---- Check 2: Order-ID collisions ----
console.log("\n=== CHECK 2: Order-ID collisions (would corrupt grouping) ===");
const multiSymbol = Array.from(orders.values()).filter((o) => o.symbols.size > 1);
const spanHours = (o: GroupedOrder): number => (o.tMax - o.tMin) / 3.6e6;
const wideSpan = Array.from(orders.values()).filter((o) => spanHours(o) > 24);
console.log(`  orders whose fills span >1 symbol : ${multiSymbol.length}  (expected 0)`);
console.log(`  orders whose fills span >24h      : ${wideSpan.length}  (expected ~0; partial fills are same-second)`);
if (multiSymbol.length) console.log("    !! collisions:", multiSymbol.slice(0, 5).map((o) => o.id));

// ---- Check 3: cross-validate against Binance's own orders/*.csv ----
console.log("\n=== CHECK 3: cross-validation against Binance orders/*.csv (independent source) ===");
const orderRows = readCsvDir(ORDERS_DIR);
const orderTime = (r: Record<string, string>): string => r["Time(UTC)"] || r["Time"];
const orderTimes = orderRows.map((r) => parseOrderDate(orderTime(r))).filter(Number.isFinite);
const winMax = Math.max(...orderTimes);
const winMin = Math.min(...orderTimes);
const fmtD = (t: number): string => new Date(t).toISOString().slice(0, 10);
console.log(`  orders/ file window: ${fmtD(winMin)} .. ${fmtD(winMax)}  (${orderRows.length.toLocaleString()} order rows)`);

const executedOrderNos = new Set(
  orderRows.filter((r) => parseAmount(r["Executed Amount"]) > 0).map((r) => r["Order No"]),
);
console.log(`  executed orders in orders/ (Executed Amount>0): ${executedOrderNos.size.toLocaleString()}`);

const ourInWindow = Array.from(orders.values()).filter((o) => o.tMin >= winMin && o.tMin <= winMax);
const ourIdsInWindow = new Set(ourInWindow.map((o) => o.id));
console.log(`  our grouped orders within that window         : ${ourIdsInWindow.size.toLocaleString()}`);

let matched = 0, ourMissingFromBinance = 0;
for (const id of Array.from(ourIdsInWindow)) (executedOrderNos.has(id) ? matched++ : ourMissingFromBinance++);
let binanceMissingFromOurs = 0;
for (const id of Array.from(executedOrderNos)) if (!orders.has(id)) binanceMissingFromOurs++;

console.log(`  our orders found in Binance orders/           : ${matched.toLocaleString()} / ${ourIdsInWindow.size.toLocaleString()} (${((100 * matched) / ourIdsInWindow.size).toFixed(2)}%)`);
console.log(`  our orders NOT in Binance orders/             : ${ourMissingFromBinance.toLocaleString()}`);
console.log(`  Binance executed orders NOT in our trades     : ${binanceMissingFromOurs.toLocaleString()}`);
console.log("\n  Interpretation: high match rate + zero symbol collisions => grouping fills by Order Id");
console.log("  reproduces Binance's own one-row-per-order ledger. Each multi-fill order = ONE trade.");
