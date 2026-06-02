import * as fs from "fs";
import {
  parseAmount,
  parseFee,
  parseOrdDate,
  parseTradeDate,
  parseTxDate,
  readCsvDir,
} from "./csv";
import { ORDERS_DIR, TRADES_DIR, TX_DIR } from "./paths";

export interface Trade {
  time: Date;
  symbol: string;
  side: string;
  price: number;
  quantity: number;
  amount: number;
  fee: number;
  realizedProfit: number;
  maker: boolean;
  orderId: string;
}

export interface Order {
  orderNo: string;
  time: Date;
  symbol: string;
  type: string;
  side: string;
  status: string;
  executed: number;
}

export interface Transaction {
  time: Date;
  type: string;
  amount: number;
  asset: string;
  symbol: string;
}

export function loadTrades(): Trade[] {
  return readCsvDir(TRADES_DIR)
    .map((r) => ({
      time: parseTradeDate(r["Time(UTC)"]),
      symbol: r["Symbol"],
      side: r["Side"],
      price: parseAmount(r["Price"]),
      quantity: parseAmount(r["Quantity"]),
      amount: parseAmount(r["Amount"]),
      fee: parseFee(r["Fee"]),
      realizedProfit: parseAmount(r["Realized Profit"]),
      maker: r["Maker"] === "true",
      orderId: r["Order Id"],
    }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}

// Order records (one row per order) — used for execution profile and cross-validation.
export function loadOrders(): Order[] {
  if (!fs.existsSync(ORDERS_DIR)) return [];
  return readCsvDir(ORDERS_DIR).map((r) => ({
    orderNo: r["Order No"],
    time: parseOrdDate(r["Time(UTC)"] || r["Time"]),
    symbol: r["Symbol"],
    type: r["Type"],
    side: r["Side"],
    status: r["Status"],
    executed: parseAmount(r["Executed Amount"]),
  }));
}

export function loadTransactions(): Transaction[] {
  return readCsvDir(TX_DIR)
    .map((r) => ({
      time: parseTxDate(r["Time"]),
      type: r["Type"],
      amount: parseAmount(r["Amount"]),
      asset: r["Asset"],
      symbol: r["Symbol"],
    }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}
