import * as path from "path";

// Single source of truth for the analysis I/O locations. The repo root is two
// levels up from src/stats. Input: the official Binance USD-M futures exports.
// Output: docs/stats (the court report and all derived artefacts).
export const ROOT = path.resolve(__dirname, "..", "..");

export const ACCOUNT_DIR = path.join(ROOT, "account", "futures", "USD-M");
export const TRADES_DIR = path.join(ACCOUNT_DIR, "trades");
export const TX_DIR = path.join(ACCOUNT_DIR, "transactions");
export const ORDERS_DIR = path.join(ACCOUNT_DIR, "orders");

export const OUT_DIR = path.join(ROOT, "docs", "stats");
export const IMG_DIR = path.join(OUT_DIR, "img");
export const STREAKS_DIR = path.join(OUT_DIR, "streaks");

// Binance's own reported USD-M wallet result, used only as a reconciliation target.
export const BINANCE_REPORTED_NET = -78046.59;

// Fixed seed -> reproducible bootstrap / Monte-Carlo figures.
export const SEED = 20260601;
