#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Binance Futures USD-M — Statistical Disadvantage Analysis (v2)
 *
 * Engine for a court-grade ("gerichtsfest") report. Computes:
 *   A) Authoritative fee / P&L reconciliation from the TRANSACTIONS ledger
 *      (REALIZED_PNL + COMMISSION + FUNDING_FEE + INSURANCE_CLEAR).
 *   B) Per-closing-order P&L distribution (for expected-value / bootstrap tests).
 *   C) Win/loss sequence + loss-streak data (for Monte-Carlo / runs test in Python).
 *
 * Emits the raw arrays a downstream Python script needs for bootstrap CIs,
 * Monte-Carlo streak simulation, the Wald-Wolfowitz runs test and the charts.
 * No external dependencies (Node built-ins only) for reproducibility.
 *
 * Output: docs/stats/new/analysis_data.json  +  docs/stats/new/monthly.csv
 */

const ROOT = path.join(__dirname, '..');
const TRADES_DIR = path.join(ROOT, 'binance', 'account', 'futures', 'USD-M', 'trades');
const TX_DIR = path.join(ROOT, 'binance', 'account', 'futures', 'USD-M', 'transactions');
const ORDERS_DIR = path.join(ROOT, 'binance', 'account', 'futures', 'USD-M', 'orders');
const OUT_DIR = path.join(ROOT, 'docs', 'stats', 'new');

// Binance's own reported USD-M wallet result, used only as a reconciliation target.
const BINANCE_REPORTED_NET = -78046.59;

// ---------------------------------------------------------------------------
// CSV parsing (carried over from v1, proven against this dataset)
// ---------------------------------------------------------------------------
function parseLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim()); current = '';
    } else { current += char; }
  }
  values.push(current.trim());
  return values;
}

function parseCSV(content) {
  const lines = content.replace(/^﻿/, '').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseLine(lines[0]);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.length === headers.length) {
      const record = {};
      for (let j = 0; j < headers.length; j++) record[headers[j]] = values[j];
      records.push(record);
    }
  }
  return records;
}

function parseAmount(value) {
  if (!value || value === '') return 0;
  const num = parseFloat(String(value).replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

// Fee fields look like "-0.00770364 USDT"; strip the asset suffix.
function parseFee(value) {
  if (!value || value === '') return 0;
  const match = String(value).match(/^-?\d+\.?\d*([eE][+-]?\d+)?/);
  if (match) { const num = parseFloat(match[0]); return isNaN(num) ? 0 : num; }
  return 0;
}

const parseTradeDate = (s) => new Date(s + 'Z'); // "2024-01-05 17:30:08"
const parseTxDate = (s) =>                         // "24-01-05 19:24:25"
  new Date('20' + s.substring(0, 2) + '-' + s.substring(3, 5) + '-' +
           s.substring(6, 8) + 'T' + s.substring(9) + 'Z');
// Orders files: old layout uses "Time(UTC)" (4-digit year), new layout "Time" (2-digit year).
const parseOrdDate = (s) => /^\d{4}-/.test(s) ? new Date(s + 'Z') : parseTxDate(s);

const getYear = (d) => d.getUTCFullYear().toString();
const getYearMonth = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function readCsvDir(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort()
    .flatMap(f => parseCSV(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
function loadTrades() {
  return readCsvDir(TRADES_DIR).map(r => ({
    time: parseTradeDate(r['Time(UTC)']),
    symbol: r['Symbol'],
    side: r['Side'],
    price: parseAmount(r['Price']),
    quantity: parseAmount(r['Quantity']),
    amount: parseAmount(r['Amount']),
    fee: parseFee(r['Fee']),
    realizedProfit: parseAmount(r['Realized Profit']),
    maker: r['Maker'] === 'true',
    orderId: r['Order Id'],
  })).sort((a, b) => a.time - b.time);
}

// Order records (one row per order) — used for execution profile and cross-validation.
function loadOrders() {
  if (!fs.existsSync(ORDERS_DIR)) return [];
  return readCsvDir(ORDERS_DIR).map(r => ({
    orderNo: r['Order No'],
    time: parseOrdDate(r['Time(UTC)'] || r['Time']),
    symbol: r['Symbol'],
    type: r['Type'],
    side: r['Side'],
    status: r['Status'],
    executed: parseAmount(r['Executed Amount']),
  }));
}

function loadTransactions() {
  return readCsvDir(TX_DIR).map(r => ({
    time: parseTxDate(r['Time']),
    type: r['Type'],
    amount: parseAmount(r['Amount']),
    asset: r['Asset'],
    symbol: r['Symbol'],
  })).sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// A) Authoritative reconciliation from the transactions ledger
// ---------------------------------------------------------------------------
// Trading-relevant flows (everything that hits the wallet because of trading).
// TRANSFER (deposits/withdrawals) and COIN_SWAP_* (balance conversions) are NOT
// trading results and are excluded from the net trading P&L.
const PNL_COMPONENTS = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE', 'INSURANCE_CLEAR'];

function reconcile(transactions) {
  const byType = {};
  for (const tx of transactions) {
    if (!byType[tx.type]) byType[tx.type] = { count: 0, total: 0 };
    byType[tx.type].count++;
    byType[tx.type].total += tx.amount;
  }
  const get = (t) => (byType[t] ? byType[t].total : 0);

  // The ledger is multi-asset (USDT, BUSD ~1:1 USD, plus a tiny amount of BNB-paid
  // commission). We sum face amounts; BUSD is a 1:1 USD stablecoin (valid as USD),
  // while BNB commissions are at face BNB value — their USD market value explains the
  // small residual versus Binance's USD "Lifetime PNL".
  const byAsset = {};
  const commissionByAsset = {};
  for (const tx of transactions) {
    if (!PNL_COMPONENTS.includes(tx.type)) continue;
    const a = tx.asset || 'UNKNOWN';
    byAsset[a] = (byAsset[a] || 0) + tx.amount;
    if (tx.type === 'COMMISSION') commissionByAsset[a] = (commissionByAsset[a] || 0) + tx.amount;
  }

  const realizedPnl = get('REALIZED_PNL');
  const commission = get('COMMISSION');
  const fundingFee = get('FUNDING_FEE');
  const insurance = get('INSURANCE_CLEAR');
  const totalFees = commission + fundingFee + insurance; // all negative
  const netTradingPnL = realizedPnl + totalFees;

  return {
    byType,
    byAsset,
    commissionByAsset,
    realizedPnl,
    commission,
    fundingFee,
    insurance,
    totalFees,
    netTradingPnL,
    // How fees devour the gross result: |fees| / |gross realized| and net/gross.
    feeToGrossRatio: realizedPnl !== 0 ? Math.abs(totalFees) / Math.abs(realizedPnl) : null,
    reportedNet: BINANCE_REPORTED_NET,
    reconciliationDelta: netTradingPnL - BINANCE_REPORTED_NET,
  };
}

// ---------------------------------------------------------------------------
// B/C) Order grouping, win/loss, streaks, distribution
// ---------------------------------------------------------------------------
function groupByOrder(trades) {
  const orders = new Map();
  for (const t of trades) {
    if (!orders.has(t.orderId)) {
      orders.set(t.orderId, {
        orderId: t.orderId, symbol: t.symbol, time: t.time,
        totalProfit: 0, totalFee: 0, notional: 0, hasRealizedProfit: false,
      });
    }
    const o = orders.get(t.orderId);
    o.totalProfit += t.realizedProfit;
    o.totalFee += t.fee;
    o.notional += Math.abs(t.amount);
    if (t.realizedProfit !== 0) { o.hasRealizedProfit = true; o.time = t.time; }
  }
  const arr = Array.from(orders.values());
  for (const o of arr) o.realPnL = o.totalProfit + o.totalFee;
  return arr.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Reconstruct economic POSITIONS from fills. A single position is often closed
// across several orders (partial closes); counting orders would overstate
// consecutive same-sign outcomes. We rebuild open->flat cycles per symbol so
// that one economic position = one "trade" for the outcome statistics.
// ---------------------------------------------------------------------------
function reconstructPositions(trades) {
  const bySym = new Map();
  for (const t of trades) {
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
    bySym.get(t.symbol).push(t); // trades are already globally time-sorted
  }
  const EPS = 1e-6;
  const finish = (c) => ({
    symbol: c.symbol, time: c.time,
    realizedProfit: c.rp, fee: c.fee, realPnL: c.rp + c.fee,
    nOrders: c.orderIds.size, hasRealizedProfit: c.rp !== 0, notional: 0,
  });
  const positions = [];
  for (const [sym, arr] of bySym) {
    let net = 0, cyc = null;
    for (const f of arr) {
      const signed = (f.side === 'BUY' ? 1 : -1) * f.quantity;
      const prev = net;
      net += signed;
      if (!cyc) cyc = { symbol: sym, rp: 0, fee: 0, time: f.time, orderIds: new Set() };
      cyc.rp += f.realizedProfit;
      cyc.fee += f.fee;
      cyc.time = f.time;
      cyc.orderIds.add(f.orderId);
      const flat = Math.abs(net) < EPS;
      const flip = prev !== 0 && Math.sign(net) !== Math.sign(prev) && !flat;
      if (flat) { positions.push(finish(cyc)); net = 0; cyc = null; }
      else if (flip) { positions.push(finish(cyc)); cyc = null; } // close + reopen
    }
    if (cyc && cyc.rp !== 0) positions.push(finish(cyc));
  }
  return positions.sort((a, b) => a.time - b.time);
}

// Streak lengths for the matching outcome ('win' | 'loss'), in order.
function streakLengths(closing, type) {
  const lengths = [];
  let cur = 0;
  for (const o of closing) {
    const match = type === 'win' ? o.realPnL > 0 : o.realPnL < 0;
    if (match) cur++;
    else { if (cur > 0) lengths.push(cur); cur = 0; }
  }
  if (cur > 0) lengths.push(cur);
  return lengths;
}

function maxOf(arr) { return arr.length ? Math.max(...arr) : 0; }

// Histogram of streak lengths -> { length: count }
function streakHistogram(lengths) {
  const h = {};
  for (const l of lengths) h[l] = (h[l] || 0) + 1;
  return h;
}

function basicDistribution(pnls) {
  const n = pnls.length;
  const sorted = [...pnls].sort((a, b) => a - b);
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const skewness = n > 2 && stdDev > 0
    ? (pnls.reduce((s, v) => s + ((v - mean) / stdDev) ** 3, 0) / n) * (n / ((n - 1) * (n - 2))) : 0;
  const kurtosisExcess = n > 3 && stdDev > 0
    ? (pnls.reduce((s, v) => s + ((v - mean) / stdDev) ** 4, 0) / n) - 3 : 0;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (n - 1))))];
  return {
    mean, median, stdDev, variance, skewness, kurtosisExcess,
    p1: pct(1), p5: pct(5), p10: pct(10), p25: pct(25),
    p75: pct(75), p90: pct(90), p95: pct(95), p99: pct(99),
  };
}

function equityCurve(closing) {
  let cum = 0, peak = 0, maxDD = 0;
  const points = [];
  for (const o of closing) {
    cum += o.realPnL;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    points.push({ t: o.time.toISOString().slice(0, 10), cum });
  }
  return { points, maxDrawdown: maxDD, finalCum: cum };
}

function summarise(orders) {
  const closing = orders.filter(o => o.hasRealizedProfit);
  const wins = closing.filter(o => o.realPnL > 0);
  const losses = closing.filter(o => o.realPnL < 0);
  const breakeven = closing.filter(o => o.realPnL === 0);

  const grossProfit = wins.reduce((s, o) => s + o.realPnL, 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + o.realPnL, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const realPnL = closing.reduce((s, o) => s + o.realPnL, 0);

  const winStreaks = streakLengths(closing, 'win');
  const lossStreaks = streakLengths(closing, 'loss');

  return {
    nOrders: orders.length,
    nClosing: closing.length,
    nWins: wins.length,
    nLosses: losses.length,
    nBreakeven: breakeven.length,
    winRate: closing.length ? wins.length / closing.length : 0,
    lossRate: closing.length ? losses.length / closing.length : 0,
    grossProfit, grossLoss,
    avgWin, avgLoss,
    rrRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    realPnLClosing: realPnL,            // sum of per-order P&L incl. fill commission
    avgTrade: closing.length ? realPnL / closing.length : 0,
    largestWin: wins.length ? Math.max(...wins.map(o => o.realPnL)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map(o => o.realPnL)) : 0,
    maxWinStreak: maxOf(winStreaks),
    maxLossStreak: maxOf(lossStreaks),
    notional: orders.reduce((s, o) => s + o.notional, 0),
  };
}

function byPeriod(orders, keyFn) {
  const map = new Map();
  for (const o of orders) {
    const k = keyFn(o.time);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(o);
  }
  const out = {};
  for (const [k, v] of [...map.entries()].sort()) out[k] = summarise(v);
  return out;
}

// Full outcome statistics for a set of "trade units" (orders OR positions).
function outcomeBlock(units) {
  const closed = units.filter(u => u.hasRealizedProfit);
  const lossStreaks = streakLengths(closed, 'loss');
  const winStreaks = streakLengths(closed, 'win');
  return {
    overall: summarise(units),
    distribution: basicDistribution(closed.map(u => u.realPnL)),
    equityCurve: equityCurve(closed),
    sequences: {
      closingPnLChrono: closed.map(u => u.realPnL),
      winLossSeq: closed.map(u => (u.realPnL > 0 ? 1 : 0)),
      lossStreaks, winStreaks,
      lossStreakHistogram: streakHistogram(lossStreaks),
      winStreakHistogram: streakHistogram(winStreaks),
    },
    byYear: byPeriod(units, getYear),
    byMonth: byPeriod(units, getYearMonth),
  };
}

// ---------------------------------------------------------------------------
// Execution profile: order-type mix, fill status, stop-loss behaviour, maker/taker
// split, and how the closing (result-bearing) orders were exited.
// ---------------------------------------------------------------------------
function executionProfile(trades, orders, closing) {
  // Maker vs taker (from fills): market orders are takers and pay the higher fee.
  let makerFee = 0, takerFee = 0, makerFills = 0, takerFills = 0;
  for (const t of trades) {
    if (t.maker) { makerFee += Math.abs(t.fee); makerFills++; }
    else { takerFee += Math.abs(t.fee); takerFills++; }
  }

  const typeCounts = {}, statusCounts = {}, typeStatus = {};
  const ordById = new Map();
  for (const o of orders) {
    typeCounts[o.type] = (typeCounts[o.type] || 0) + 1;
    statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    const k = `${o.type} / ${o.status}`;
    typeStatus[k] = (typeStatus[k] || 0) + 1;
    ordById.set(o.orderNo, o);
  }

  const isStop = (t) => t === 'STOP_MARKET' || t === 'STOP';
  const stopTotal = orders.filter(o => isStop(o.type)).length;
  const stopFilled = orders.filter(o => isStop(o.type) && o.status === 'FILLED').length;

  // How were the 6,367 result-bearing positions exited?
  const exitTypes = {};
  let matched = 0;
  for (const o of closing) {
    const ord = ordById.get(o.orderId);
    const t = ord ? ord.type : 'UNKNOWN';
    if (ord) matched++;
    if (!exitTypes[t]) exitTypes[t] = { n: 0, wins: 0, sumPnL: 0 };
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
    typeCounts, statusCounts, typeStatus,
    stop: { total: stopTotal, filled: stopFilled, triggerRate: stopTotal ? stopFilled / stopTotal : 0 },
    makerTaker: {
      makerFills, takerFills, makerFee: -makerFee, takerFee: -takerFee,
      takerFillShare: (makerFills + takerFills) ? takerFills / (makerFills + takerFills) : 0,
      takerFeeShare: (makerFee + takerFee) ? takerFee / (makerFee + takerFee) : 0,
    },
    exitTypes,
    closingMatchedToOrders: matched,
    closingTotal: closing.length,
  };
}

// Forced liquidations leave an INSURANCE_CLEAR footprint in the ledger.
function liquidationProfile(transactions) {
  const ins = transactions.filter(t => t.type === 'INSURANCE_CLEAR');
  const byYear = {};
  for (const t of ins) {
    const y = t.time.getUTCFullYear().toString();
    if (!byYear[y]) byYear[y] = { count: 0, total: 0 };
    byYear[y].count++;
    byYear[y].total += t.amount;
  }
  return { count: ins.length, total: ins.reduce((s, t) => s + t.amount, 0), byYear };
}

// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Loading USD-M futures data...');
  const trades = loadTrades();
  const transactions = loadTransactions();
  console.log(`  ${trades.length.toLocaleString()} fills, ${transactions.length.toLocaleString()} ledger entries`);

  const orderRecords = loadOrders();
  console.log(`  ${orderRecords.length.toLocaleString()} order records`);

  const recon = reconcile(transactions);
  const orders = groupByOrder(trades);
  const closing = orders.filter(o => o.hasRealizedProfit);
  const execution = executionProfile(trades, orderRecords, closing);
  const liquidations = liquidationProfile(transactions);

  // Outcome statistics at BOTH order level and economic-position level. Positions
  // are the primary unit (one position = one trade), which removes the partial-close
  // inflation of streaks; order level is kept for fee/notional context and robustness.
  const orderBlock = outcomeBlock(orders);
  const positions = reconstructPositions(trades);
  const positionBlock = outcomeBlock(positions);
  const overall = orderBlock.overall; // order-level: carries traded notional

  // Effective trading cost in basis points of traded notional.
  const costBps = overall.notional > 0
    ? (Math.abs(recon.totalFees) / overall.notional) * 10000 : null;
  const commissionBps = overall.notional > 0
    ? (Math.abs(recon.commission) / overall.notional) * 10000 : null;

  // Robustness: how the trade unit (order vs position) affects the headline figures.
  const validation = {
    closingOrders: orderBlock.overall.nClosing,
    positions: positionBlock.overall.nClosing,
    orderWinRate: orderBlock.overall.winRate,
    positionWinRate: positionBlock.overall.winRate,
    orderMaxLossStreak: orderBlock.overall.maxLossStreak,
    positionMaxLossStreak: positionBlock.overall.maxLossStreak,
    orderRrRatio: orderBlock.overall.rrRatio,
    positionRrRatio: positionBlock.overall.rrRatio,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Binance Futures USD-M',
    unit: 'economic position (open->flat cycle); order-level under `orders`',
    dataFiles: {
      trades: fs.readdirSync(TRADES_DIR).filter(f => f.endsWith('.csv')).sort(),
      transactions: fs.readdirSync(TX_DIR).filter(f => f.endsWith('.csv')).sort(),
    },
    reconciliation: recon,
    costBps,
    commissionBps,
    volumeNotional: overall.notional,
    execution,
    liquidations,
    validation,
    // PRIMARY outcome statistics — at economic-position level
    overall: positionBlock.overall,
    distribution: positionBlock.distribution,
    equityCurve: positionBlock.equityCurve,
    sequences: positionBlock.sequences,
    byYear: positionBlock.byYear,
    byMonth: positionBlock.byMonth,
    // Order-level block (robustness / fee context)
    orders: orderBlock,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'analysis_data.json'), JSON.stringify(report, null, 2));

  // Monthly CSV for spreadsheet inspection
  const months = Object.keys(report.byMonth).sort();
  const header = ['Period', 'Closing', 'Wins', 'Losses', 'WinRate', 'RealPnLClosing',
    'GrossProfit', 'GrossLoss', 'ProfitFactor', 'AvgTrade', 'AvgWin', 'AvgLoss',
    'RrRatio', 'MaxLossStreak', 'MaxWinStreak'];
  const rows = months.map(m => {
    const s = report.byMonth[m];
    return [m, s.nClosing, s.nWins, s.nLosses, (s.winRate * 100).toFixed(2),
      s.realPnLClosing.toFixed(2), s.grossProfit.toFixed(2), s.grossLoss.toFixed(2),
      (s.profitFactor == null ? '' : s.profitFactor.toFixed(3)), s.avgTrade.toFixed(2),
      s.avgWin.toFixed(2), s.avgLoss.toFixed(2), s.rrRatio.toFixed(3),
      s.maxLossStreak, s.maxWinStreak].join(',');
  });
  fs.writeFileSync(path.join(OUT_DIR, 'monthly.csv'), [header.join(','), ...rows].join('\n'));

  // ---- console reconciliation report ----
  const fmt = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log('\n=== TRANSACTION LEDGER RECONCILIATION (USD-M) ===');
  for (const [type, d] of Object.entries(recon.byType).sort((a, b) => a[1].total - b[1].total)) {
    console.log(`  ${type.padEnd(20)} ${String(d.count).padStart(7)}  ${fmt(d.total).padStart(16)}`);
  }
  console.log('  ' + '-'.repeat(46));
  console.log(`  Gross realized P&L      ${fmt(recon.realizedPnl).padStart(16)}`);
  console.log(`  Commissions             ${fmt(recon.commission).padStart(16)}`);
  console.log(`  Funding fees            ${fmt(recon.fundingFee).padStart(16)}`);
  console.log(`  Insurance clear         ${fmt(recon.insurance).padStart(16)}`);
  console.log(`  Total fees              ${fmt(recon.totalFees).padStart(16)}`);
  console.log(`  NET trading P&L         ${fmt(recon.netTradingPnL).padStart(16)}`);
  console.log(`  Binance reported        ${fmt(recon.reportedNet).padStart(16)}`);
  console.log(`  Reconciliation delta    ${fmt(recon.reconciliationDelta).padStart(16)}`);
  console.log(`  Fee-to-gross ratio      ${recon.feeToGrossRatio == null ? 'n/a' : recon.feeToGrossRatio.toFixed(1) + 'x'}`);
  console.log(`  Effective cost          ${costBps == null ? 'n/a' : costBps.toFixed(2) + ' bps of notional'}`);
  console.log('  Net by ledger asset (BUSD = 1:1 USD; BNB at face value):');
  for (const [a, v] of Object.entries(recon.byAsset).sort((x, y) => x[1] - y[1])) {
    const cb = recon.commissionByAsset[a] ? `  (commission ${fmt(recon.commissionByAsset[a])})` : '';
    console.log(`    ${a.padEnd(6)} ${fmt(v).padStart(14)}${cb}`);
  }
  const pos = positionBlock.overall;
  console.log('\n=== TRADE OUTCOMES (economic positions — primary unit) ===');
  console.log(`  Positions               ${pos.nClosing}`);
  console.log(`  Win rate                ${(pos.winRate * 100).toFixed(2)}%  (${pos.nWins} W / ${pos.nLosses} L)`);
  console.log(`  Avg trade (incl. comm.) ${fmt(pos.avgTrade)}`);
  console.log(`  R:R (avgWin/avgLoss)    1:${pos.rrRatio.toFixed(2)}`);
  console.log(`  Max loss streak         ${pos.maxLossStreak}`);
  console.log(`  Profit factor           ${pos.profitFactor == null ? 'n/a' : pos.profitFactor.toFixed(3)}`);

  console.log('\n=== ROBUSTNESS: order vs position unit ===');
  console.log(`  Closing orders / positions     ${validation.closingOrders} / ${validation.positions}`);
  console.log(`  Win rate  order / position     ${(validation.orderWinRate * 100).toFixed(2)}% / ${(validation.positionWinRate * 100).toFixed(2)}%`);
  console.log(`  Max loss streak order / pos    ${validation.orderMaxLossStreak} / ${validation.positionMaxLossStreak}`);

  console.log('\n=== EXECUTION PROFILE (orders) ===');
  console.log(`  Order records           ${execution.nOrders.toLocaleString()}`);
  for (const [t, c] of Object.entries(execution.typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(13)} ${String(c).padStart(6)}`);
  }
  console.log(`  Stop orders             ${execution.stop.total} total, ${execution.stop.filled} triggered (${(execution.stop.triggerRate * 100).toFixed(2)}%)`);
  const mt = execution.makerTaker;
  console.log(`  Taker fills             ${mt.takerFills.toLocaleString()} (${(mt.takerFillShare * 100).toFixed(1)}%)  |  Maker fills ${mt.makerFills}`);
  console.log(`  Taker commission        ${fmt(mt.takerFee)} (${(mt.takerFeeShare * 100).toFixed(1)}% of all commission)`);
  console.log(`  Commission rate         ${commissionBps == null ? 'n/a' : commissionBps.toFixed(2) + ' bps of notional'}`);
  console.log('  Closing orders by exit type:');
  for (const [t, e] of Object.entries(execution.exitTypes).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${t.padEnd(13)} n=${String(e.n).padStart(5)}  winRate=${(e.winRate * 100).toFixed(1).padStart(5)}%  sumPnL=${fmt(e.sumPnL).padStart(12)}`);
  }
  console.log(`  Closing matched to order records: ${execution.closingMatchedToOrders}/${execution.closingTotal}`);

  console.log('\n=== FORCED LIQUIDATIONS (INSURANCE_CLEAR) ===');
  console.log(`  Total                   ${liquidations.count} events, ${fmt(liquidations.total)}`);
  for (const [y, d] of Object.entries(liquidations.byYear).sort()) {
    console.log(`    ${y}                  ${String(d.count).padStart(4)} events  ${fmt(d.total).padStart(12)}`);
  }

  console.log(`\nWrote ${path.join('docs', 'stats', 'new', 'analysis_data.json')} and monthly.csv`);
}

main();
