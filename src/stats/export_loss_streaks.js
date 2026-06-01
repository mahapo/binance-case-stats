#!/usr/bin/env node

/**
 * Export the THREE longest loss streaks (at economic-position level — the unit used
 * in the Gutachten) to CSV, including EVERY fill (all original columns) for the window
 * that runs from the last profitable position BEFORE the streak to the first profitable
 * position AFTER it.
 *
 * For each streak it writes docs/stats/new/streaks/loss_streak_<rank>.csv and also a
 * combined docs/stats/new/streaks/loss_streaks_top3.csv. Each row is one raw fill with
 * the original trade columns plus position/streak annotations.
 *
 * Run:  node scripts/export_loss_streaks.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRADES_DIR = path.join(ROOT, 'binance', 'account', 'futures', 'USD-M', 'trades');
const OUT_DIR = path.join(ROOT, 'docs', 'stats', 'new', 'streaks');
const TOP_N = 3;

// ---- CSV parsing (identical to the engine) ----
function parseLine(line) {
  const v = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i], n = line[i + 1];
    if (ch === '"') { if (q && n === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { v.push(c.trim()); c = ''; }
    else c += ch;
  }
  v.push(c.trim());
  return v;
}
function parseRows(content) {
  const lines = content.replace(/^﻿/, '').split('\n').filter(l => l.trim());
  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    if (vals.length === headers.length) {
      const r = {}; headers.forEach((h, j) => r[h] = vals[j]); rows.push(r);
    }
  }
  return { headers, rows };
}
const num = (s) => { if (!s) return 0; const m = String(s).match(/^-?\d+\.?\d*([eE][+-]?\d+)?/); return m ? (parseFloat(m[0]) || 0) : 0; };
const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

// ---- Load fills, keep the raw record + the parsed fields we need ----
let TRADE_HEADERS = null;
const fills = [];
for (const f of fs.readdirSync(TRADES_DIR).filter(f => f.endsWith('.csv')).sort()) {
  const { headers, rows } = parseRows(fs.readFileSync(path.join(TRADES_DIR, f), 'utf-8'));
  if (!TRADE_HEADERS) TRADE_HEADERS = headers;
  for (const r of rows) {
    fills.push({
      raw: r,
      time: new Date(r['Time(UTC)'] + 'Z'),
      symbol: r['Symbol'],
      side: r['Side'],
      qty: num(r['Quantity']),
      realized: num(r['Realized Profit']),
      fee: (() => { const m = String(r['Fee']).match(/^-?\d+\.?\d*/); return m ? parseFloat(m[0]) : 0; })(),
    });
  }
}
fills.sort((a, b) => a.time - b.time);

// ---- Reconstruct economic positions, retaining each position's fills ----
const EPS = 1e-6;
const bySym = new Map();
for (const f of fills) { if (!bySym.has(f.symbol)) bySym.set(f.symbol, []); bySym.get(f.symbol).push(f); }
const positions = [];
for (const [sym, arr] of bySym) {
  let net = 0, cyc = null;
  const close = () => {
    cyc.pnl = cyc.realized + cyc.fee;
    cyc.openTime = cyc.fills[0].time;
    cyc.closeTime = cyc.fills[cyc.fills.length - 1].time;
    cyc.orderIds = [...new Set(cyc.fills.map(x => x.raw['Order Id']))];
    positions.push(cyc);
    cyc = null;
  };
  for (const f of arr) {
    const signed = (f.side === 'BUY' ? 1 : -1) * f.qty;
    const prev = net; net += signed;
    if (!cyc) cyc = { symbol: sym, realized: 0, fee: 0, fills: [] };
    cyc.realized += f.realized; cyc.fee += f.fee; cyc.fills.push(f);
    const flat = Math.abs(net) < EPS;
    const flip = prev !== 0 && Math.sign(net) !== Math.sign(prev) && !flat;
    if (flat) { net = 0; close(); }
    else if (flip) close();
  }
  if (cyc && cyc.realized !== 0) close();
}

// Closed (result-bearing) positions in chronological close order — the streak sequence.
const closed = positions.filter(p => p.realized !== 0).sort((a, b) => a.closeTime - b.closeTime);
closed.forEach((p, i) => { p.idx = i; p.outcome = p.pnl > 0 ? 'WIN' : (p.pnl < 0 ? 'LOSS' : 'BREAKEVEN'); });

// ---- Find maximal loss streaks (runs of LOSS positions) ----
const streaks = [];
let start = -1;
for (let i = 0; i < closed.length; i++) {
  const isLoss = closed[i].pnl < 0;
  if (isLoss && start === -1) start = i;
  if (!isLoss && start !== -1) { streaks.push({ start, end: i - 1, length: i - start }); start = -1; }
}
if (start !== -1) streaks.push({ start, end: closed.length - 1, length: closed.length - start });
streaks.sort((a, b) => b.length - a.length || a.start - b.start);
const top = streaks.slice(0, TOP_N);

// ---- For each top streak: window = nearest WIN before .. nearest WIN after ----
const META = ['streak_rank', 'streak_length', 'window_role', 'position_seq', 'position_symbol',
  'position_open_utc', 'position_close_utc', 'position_realized', 'position_fee',
  'position_pnl', 'position_outcome', 'position_n_fills', 'position_order_ids'];
const fmt = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const iso = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const combinedRows = [];
const headerRow = [...META, ...TRADE_HEADERS].map(csvCell).join(',');

console.log(`Reconstructed ${closed.length} closed positions; found ${streaks.length} loss streaks.`);
console.log(`Top ${TOP_N} loss-streak lengths: ${top.map(s => s.length).join(', ')}\n`);

top.forEach((s, r) => {
  const rank = r + 1;
  // nearest profitable position before the streak (boundary), skipping breakevens
  let preIdx = s.start - 1; while (preIdx >= 0 && closed[preIdx].pnl <= 0) preIdx--;
  let postIdx = s.end + 1; while (postIdx < closed.length && closed[postIdx].pnl <= 0) postIdx++;

  const windowPositions = [];
  if (preIdx >= 0) windowPositions.push({ pos: closed[preIdx], role: 'PRE_WIN_BOUNDARY' });
  for (let i = s.start; i <= s.end; i++) windowPositions.push({ pos: closed[i], role: 'LOSS_STREAK' });
  if (postIdx < closed.length) windowPositions.push({ pos: closed[postIdx], role: 'POST_WIN_BOUNDARY' });

  const rows = [headerRow];
  let seq = 0;
  let streakPnL = 0;
  for (const { pos, role } of windowPositions) {
    seq++;
    if (role === 'LOSS_STREAK') streakPnL += pos.pnl;
    const meta = [rank, s.length, role, seq, pos.symbol, iso(pos.openTime), iso(pos.closeTime),
      pos.realized.toFixed(8), pos.fee.toFixed(8), pos.pnl.toFixed(8), pos.outcome,
      pos.fills.length, pos.orderIds.join('|')];
    for (const fill of pos.fills) {
      const line = [...meta.map(csvCell), ...TRADE_HEADERS.map(h => csvCell(fill.raw[h]))].join(',');
      rows.push(line);
      combinedRows.push(line);
    }
  }

  const outPath = path.join(OUT_DIR, `loss_streak_${rank}.csv`);
  fs.writeFileSync(outPath, rows.join('\n') + '\n');

  const pre = preIdx >= 0 ? closed[preIdx] : null;
  const post = postIdx < closed.length ? closed[postIdx] : null;
  const totalFills = windowPositions.reduce((a, w) => a + w.pos.fills.length, 0);
  console.log(`#${rank}  ${s.length} consecutive losing positions  (${fmt(streakPnL)})`);
  console.log(`     window: ${iso(windowPositions[0].pos.openTime)} .. ${iso(windowPositions[windowPositions.length - 1].pos.closeTime)}`);
  console.log(`     symbols: ${[...new Set(windowPositions.map(w => w.pos.symbol))].join(', ')}`);
  console.log(`     pre-win:  ${pre ? `${pre.symbol} ${fmt(pre.pnl)} @ ${iso(pre.closeTime)}` : '(streak at very start — none)'}`);
  console.log(`     post-win: ${post ? `${post.symbol} ${fmt(post.pnl)} @ ${iso(post.closeTime)}` : '(streak at very end — none)'}`);
  console.log(`     positions in window: ${windowPositions.length}  |  fills (rows): ${totalFills}`);
  console.log(`     -> ${path.relative(ROOT, outPath)}\n`);
});

const combinedPath = path.join(OUT_DIR, 'loss_streaks_top3.csv');
fs.writeFileSync(combinedPath, [headerRow, ...combinedRows].join('\n') + '\n');
console.log(`Combined file: ${path.relative(ROOT, combinedPath)} (${combinedRows.length} fill rows)`);
