#!/usr/bin/env node

/**
 * Verification harness for futures_analysis_v2.js — proves that the fill -> order
 * grouping is correct and bullet-proof, by:
 *
 *   1) Drilling into specific Order IDs and showing every fill collapses into ONE order.
 *   2) Checking for Order-ID collisions (same ID across different symbols / far-apart times),
 *      which would be the only way grouping-by-ID could merge unrelated trades.
 *   3) Independently cross-validating the grouped order count and identity against Binance's
 *      OWN order records in binance/account/futures/USD-M/orders/*.csv (one row = one order).
 *
 * Run:  node scripts/verify_grouping.js              (runs all checks)
 *       node scripts/verify_grouping.js 111147095130 (also deep-dives that Order ID)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRADES_DIR = path.join(ROOT, 'binance', 'account', 'futures', 'USD-M', 'trades');
const ORDERS_DIR = path.join(ROOT, 'binance', 'account', 'futures', 'USD-M', 'orders');

// ---- CSV parsing (identical to the engine) ----
function parseLine(line) {
  const v = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], n = line[i + 1];
    if (c === '"') { if (q && n === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { v.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  v.push(cur.trim());
  return v;
}
function parseCSV(content) {
  const lines = content.replace(/^﻿/, '').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const h = parseLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    if (vals.length === h.length) { const r = {}; h.forEach((k, j) => r[k] = vals[j]); out.push(r); }
  }
  return out;
}
const num = (s) => { if (!s) return 0; const m = String(s).match(/^-?\d+\.?\d*([eE][+-]?\d+)?/); return m ? (parseFloat(m[0]) || 0) : 0; };
// Orders files exist in two layouts: old has "Time(UTC)" (4-digit year), new has "Time" (2-digit year).
const orderTime = (r) => r['Time(UTC)'] || r['Time'];
const parseOrderDate = (s) => /^\d{4}-/.test(s) ? Date.parse(s + 'Z')
  : Date.parse('20' + s.slice(0, 2) + '-' + s.slice(3, 5) + '-' + s.slice(6, 8) + 'T' + s.slice(9) + 'Z');
const readDir = (d) => fs.readdirSync(d).filter(f => f.endsWith('.csv')).sort()
  .flatMap(f => parseCSV(fs.readFileSync(path.join(d, f), 'utf-8')).map(r => ({ ...r, __file: f })));

// ---- Load & group exactly like the engine ----
const tradeRows = readDir(TRADES_DIR);
const orders = new Map();
for (const r of tradeRows) {
  const id = r['Order Id'];
  if (!orders.has(id)) orders.set(id, {
    id, symbols: new Set(), fills: 0, qty: 0, notional: 0,
    realized: 0, fee: 0, tMin: Infinity, tMax: -Infinity,
  });
  const o = orders.get(id);
  o.symbols.add(r['Symbol']);
  o.fills++;
  o.qty += num(r['Quantity']);
  o.notional += Math.abs(num(r['Amount']));
  o.realized += num(r['Realized Profit']);
  o.fee += num(r['Fee']);
  const t = Date.parse(r['Time(UTC)'] + 'Z');
  o.tMin = Math.min(o.tMin, t); o.tMax = Math.max(o.tMax, t);
}
for (const o of orders.values()) {
  o.realPnL = o.realized + o.fee;
  o.closing = o.realized !== 0;
}

console.log(`Loaded ${tradeRows.length.toLocaleString()} fills -> ${orders.size.toLocaleString()} unique orders`);
const closing = [...orders.values()].filter(o => o.closing);
console.log(`  closing (result-bearing) orders: ${closing.length.toLocaleString()}`);
console.log(`  opening orders:                  ${(orders.size - closing.length).toLocaleString()}`);

// ---- Check 1: deep-dive specific Order IDs ----
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['111147095130', '11464316356'];
console.log('\n=== CHECK 1: specific Order IDs collapse into exactly ONE order ===');
for (const id of targets) {
  const o = orders.get(id);
  if (!o) { console.log(`  ${id}: NOT FOUND`); continue; }
  console.log(`  Order ${id}`);
  console.log(`    fills merged into this order : ${o.fills}`);
  console.log(`    distinct symbols             : ${[...o.symbols].join(', ')}  (must be 1)`);
  console.log(`    summed quantity              : ${o.qty.toFixed(8)}`);
  console.log(`    summed realized profit       : ${o.realized.toFixed(8)}`);
  console.log(`    summed fee                   : ${o.fee.toFixed(8)}`);
  console.log(`    order realPnL                : ${o.realPnL.toFixed(4)}`);
  console.log(`    classified as                : ${o.closing ? (o.realPnL > 0 ? 'WIN (1 trade)' : 'LOSS (1 trade)') : 'opening (not counted)'}`);
  console.log(`    => contributes ${o.closing ? 1 : 0} trade to win/loss stats (NOT ${o.fills})`);
}

// ---- Check 2: Order-ID collisions ----
console.log('\n=== CHECK 2: Order-ID collisions (would corrupt grouping) ===');
const multiSymbol = [...orders.values()].filter(o => o.symbols.size > 1);
const spanHours = (o) => (o.tMax - o.tMin) / 3.6e6;
const wideSpan = [...orders.values()].filter(o => spanHours(o) > 24);
console.log(`  orders whose fills span >1 symbol : ${multiSymbol.length}  (expected 0)`);
console.log(`  orders whose fills span >24h      : ${wideSpan.length}  (expected ~0; partial fills are same-second)`);
if (multiSymbol.length) console.log('    !! collisions:', multiSymbol.slice(0, 5).map(o => o.id));

// ---- Check 3: cross-validate against Binance's own orders/*.csv ----
console.log('\n=== CHECK 3: cross-validation against Binance orders/*.csv (independent source) ===');
const orderRows = readDir(ORDERS_DIR);
// orders file covers only part of the timeline; restrict the comparison to its window.
const orderTimes = orderRows.map(r => parseOrderDate(orderTime(r))).filter(Number.isFinite);
const winMax = Math.max(...orderTimes);
const winMin = Math.min(...orderTimes);
const fmtD = (t) => new Date(t).toISOString().slice(0, 10);
console.log(`  orders/ file window: ${fmtD(winMin)} .. ${fmtD(winMax)}  (${orderRows.length.toLocaleString()} order rows)`);

// Binance order numbers that actually executed something (Executed Amount > 0).
const executedOrderNos = new Set(
  orderRows.filter(r => num(r['Executed Amount']) > 0).map(r => r['Order No'])
);
console.log(`  executed orders in orders/ (Executed Amount>0): ${executedOrderNos.size.toLocaleString()}`);

// Our grouped orders that fall within the same window (group start time).
const ourInWindow = [...orders.values()].filter(o => o.tMin >= winMin && o.tMin <= winMax);
const ourIdsInWindow = new Set(ourInWindow.map(o => o.id));
console.log(`  our grouped orders within that window         : ${ourIdsInWindow.size.toLocaleString()}`);

let matched = 0, ourMissingFromBinance = 0;
for (const id of ourIdsInWindow) (executedOrderNos.has(id) ? matched++ : ourMissingFromBinance++);
let binanceMissingFromOurs = 0;
for (const id of executedOrderNos) if (!orders.has(id)) binanceMissingFromOurs++;

console.log(`  our orders found in Binance orders/           : ${matched.toLocaleString()} / ${ourIdsInWindow.size.toLocaleString()} (${(100 * matched / ourIdsInWindow.size).toFixed(2)}%)`);
console.log(`  our orders NOT in Binance orders/             : ${ourMissingFromBinance.toLocaleString()}`);
console.log(`  Binance executed orders NOT in our trades     : ${binanceMissingFromOurs.toLocaleString()}`);
console.log('\n  Interpretation: high match rate + zero symbol collisions => grouping fills by Order Id');
console.log('  reproduces Binance\'s own one-row-per-order ledger. Each multi-fill order = ONE trade.');
