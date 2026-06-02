#!/usr/bin/env ts-node
/**
 * Export the THREE longest loss streaks (at economic-position level — the unit used
 * in the Gutachten) to CSV, including EVERY fill (all original columns) for the window
 * that runs from the last profitable position BEFORE the streak to the first profitable
 * position AFTER it.
 *
 * Writes docs/stats/streaks/loss_streak_<rank>.csv and a combined loss_streaks_top3.csv.
 * Each row is one raw fill with the original trade columns plus position/streak annotations.
 *
 * Run:  npm run stats:streaks
 */
import * as fs from "fs";
import * as path from "path";
import { listCsv, parseCSV, parseFee, parseLine } from "./csv";
import { STREAKS_DIR, TRADES_DIR } from "./paths";

const TOP_N = 3;
const num = (s: string | undefined): number => parseFee(s);
const csvCell = (v: unknown): string => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';

interface Fill {
  raw: Record<string, string>;
  time: Date;
  symbol: string;
  side: string;
  qty: number;
  realized: number;
  fee: number;
}

interface Position {
  symbol: string;
  realized: number;
  fee: number;
  fills: Fill[];
  pnl: number;
  openTime: Date;
  closeTime: Date;
  orderIds: string[];
  idx?: number;
  outcome?: string;
}

// ---- Load fills, keep the raw record + the parsed fields we need ----
let TRADE_HEADERS: string[] | null = null;
const fills: Fill[] = [];
for (const f of listCsv(TRADES_DIR)) {
  const content = fs.readFileSync(path.join(TRADES_DIR, f), "utf-8");
  if (!TRADE_HEADERS) {
    const firstLine = content.replace(/^﻿/, "").split("\n")[0];
    TRADE_HEADERS = parseLine(firstLine);
  }
  for (const r of parseCSV(content)) {
    fills.push({
      raw: r,
      time: new Date(r["Time(UTC)"] + "Z"),
      symbol: r["Symbol"],
      side: r["Side"],
      qty: num(r["Quantity"]),
      realized: num(r["Realized Profit"]),
      fee: num(r["Fee"]),
    });
  }
}
fills.sort((a, b) => a.time.getTime() - b.time.getTime());

// ---- Reconstruct economic positions, retaining each position's fills ----
const EPS = 1e-6;
const bySym = new Map<string, Fill[]>();
for (const f of fills) {
  if (!bySym.has(f.symbol)) bySym.set(f.symbol, []);
  bySym.get(f.symbol)!.push(f);
}
const positions: Position[] = [];
for (const [sym, arr] of Array.from(bySym.entries())) {
  let net = 0;
  let cyc: Position | null = null;
  const close = (): void => {
    cyc!.pnl = cyc!.realized + cyc!.fee;
    cyc!.openTime = cyc!.fills[0].time;
    cyc!.closeTime = cyc!.fills[cyc!.fills.length - 1].time;
    cyc!.orderIds = Array.from(new Set(cyc!.fills.map((x) => x.raw["Order Id"])));
    positions.push(cyc!);
    cyc = null;
  };
  for (const f of arr) {
    const signed = (f.side === "BUY" ? 1 : -1) * f.qty;
    const prev = net;
    net += signed;
    if (!cyc) cyc = { symbol: sym, realized: 0, fee: 0, fills: [] } as Position;
    cyc.realized += f.realized;
    cyc.fee += f.fee;
    cyc.fills.push(f);
    const flat = Math.abs(net) < EPS;
    const flip = prev !== 0 && Math.sign(net) !== Math.sign(prev) && !flat;
    if (flat) {
      net = 0;
      close();
    } else if (flip) {
      close();
    }
  }
  if (cyc && (cyc as Position).realized !== 0) close();
}

// Closed (result-bearing) positions in chronological close order — the streak sequence.
const closed = positions
  .filter((p) => p.realized !== 0)
  .sort((a, b) => a.closeTime.getTime() - b.closeTime.getTime());
closed.forEach((p, i) => {
  p.idx = i;
  p.outcome = p.pnl > 0 ? "WIN" : p.pnl < 0 ? "LOSS" : "BREAKEVEN";
});

// ---- Find maximal loss streaks (runs of LOSS positions) ----
interface Streak { start: number; end: number; length: number; }
const streaks: Streak[] = [];
let start = -1;
for (let i = 0; i < closed.length; i++) {
  const isLoss = closed[i].pnl < 0;
  if (isLoss && start === -1) start = i;
  if (!isLoss && start !== -1) {
    streaks.push({ start, end: i - 1, length: i - start });
    start = -1;
  }
}
if (start !== -1) streaks.push({ start, end: closed.length - 1, length: closed.length - start });
streaks.sort((a, b) => b.length - a.length || a.start - b.start);
const top = streaks.slice(0, TOP_N);

// ---- For each top streak: window = nearest WIN before .. nearest WIN after ----
const META = ["streak_rank", "streak_length", "window_role", "position_seq", "position_symbol",
  "position_open_utc", "position_close_utc", "position_realized", "position_fee",
  "position_pnl", "position_outcome", "position_n_fills", "position_order_ids"];
const fmt = (n: number): string =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const iso = (d: Date): string => d.toISOString().replace("T", " ").slice(0, 19);

if (!fs.existsSync(STREAKS_DIR)) fs.mkdirSync(STREAKS_DIR, { recursive: true });
const headers = TRADE_HEADERS!;
const combinedRows: string[] = [];
const headerRow = [...META, ...headers].map(csvCell).join(",");

console.log(`Reconstructed ${closed.length} closed positions; found ${streaks.length} loss streaks.`);
console.log(`Top ${TOP_N} loss-streak lengths: ${top.map((s) => s.length).join(", ")}\n`);

top.forEach((s, r) => {
  const rank = r + 1;
  let preIdx = s.start - 1;
  while (preIdx >= 0 && closed[preIdx].pnl <= 0) preIdx--;
  let postIdx = s.end + 1;
  while (postIdx < closed.length && closed[postIdx].pnl <= 0) postIdx++;

  const windowPositions: { pos: Position; role: string }[] = [];
  if (preIdx >= 0) windowPositions.push({ pos: closed[preIdx], role: "PRE_WIN_BOUNDARY" });
  for (let i = s.start; i <= s.end; i++) windowPositions.push({ pos: closed[i], role: "LOSS_STREAK" });
  if (postIdx < closed.length) windowPositions.push({ pos: closed[postIdx], role: "POST_WIN_BOUNDARY" });

  const rows = [headerRow];
  let seq = 0;
  let streakPnL = 0;
  for (const { pos, role } of windowPositions) {
    seq++;
    if (role === "LOSS_STREAK") streakPnL += pos.pnl;
    const meta = [rank, s.length, role, seq, pos.symbol, iso(pos.openTime), iso(pos.closeTime),
      pos.realized.toFixed(8), pos.fee.toFixed(8), pos.pnl.toFixed(8), pos.outcome,
      pos.fills.length, pos.orderIds.join("|")];
    for (const fill of pos.fills) {
      const line = [...meta.map(csvCell), ...headers.map((h) => csvCell(fill.raw[h]))].join(",");
      rows.push(line);
      combinedRows.push(line);
    }
  }

  const outPath = path.join(STREAKS_DIR, `loss_streak_${rank}.csv`);
  fs.writeFileSync(outPath, rows.join("\n") + "\n");

  const pre = preIdx >= 0 ? closed[preIdx] : null;
  const post = postIdx < closed.length ? closed[postIdx] : null;
  const totalFills = windowPositions.reduce((a, w) => a + w.pos.fills.length, 0);
  console.log(`#${rank}  ${s.length} consecutive losing positions  (${fmt(streakPnL)})`);
  console.log(`     window: ${iso(windowPositions[0].pos.openTime)} .. ${iso(windowPositions[windowPositions.length - 1].pos.closeTime)}`);
  console.log(`     symbols: ${Array.from(new Set(windowPositions.map((w) => w.pos.symbol))).join(", ")}`);
  console.log(`     pre-win:  ${pre ? `${pre.symbol} ${fmt(pre.pnl)} @ ${iso(pre.closeTime)}` : "(streak at very start — none)"}`);
  console.log(`     post-win: ${post ? `${post.symbol} ${fmt(post.pnl)} @ ${iso(post.closeTime)}` : "(streak at very end — none)"}`);
  console.log(`     positions in window: ${windowPositions.length}  |  fills (rows): ${totalFills}`);
  console.log(`     -> ${path.relative(process.cwd(), outPath)}\n`);
});

const combinedPath = path.join(STREAKS_DIR, "loss_streaks_top3.csv");
fs.writeFileSync(combinedPath, [headerRow, ...combinedRows].join("\n") + "\n");
console.log(`Combined file: ${path.relative(process.cwd(), combinedPath)} (${combinedRows.length} fill rows)`);
