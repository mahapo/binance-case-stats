import * as fs from "fs";

// Loads price ticks for the backtester and provides a synthetic-tick helper for
// deterministic tests.

export interface Tick {
  time: number; // milliseconds
  price: number;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export class PriceLoader {
  /**
   * Load ticks from a CSV. Auto-detects the time and price columns, so it
   * handles the Binance official trades export
   * (`id,price,qty,quote_qty,time,is_buyer_maker`, `time` in ms), the
   * trade-prints format (`…,unix,price,…`) and the simple `unix,price` format.
   * Returns ticks sorted ascending by time. Pass `limit` to read only the first
   * N ticks (the export is already chronological) — useful for big files.
   */
  static loadTicks(csvPath: string, limit = Infinity): Tick[] {
    const content = fs.readFileSync(csvPath, "utf-8").replace(/^﻿/, "");
    const newline = content.indexOf("\n");
    if (newline === -1) return [];

    const headers = parseCsvLine(content.slice(0, newline)).map((h) =>
      h.toLowerCase()
    );
    const timeIdx = headers.findIndex(
      (h) => h === "unix" || h === "time" || h === "timestamp"
    );
    const priceIdx = headers.indexOf("price");
    if (timeIdx === -1 || priceIdx === -1) {
      throw new Error(`PriceLoader: could not find time/price columns in ${csvPath}`);
    }

    const ticks: Tick[] = [];
    let pos = newline + 1;
    while (pos < content.length && ticks.length < limit) {
      let end = content.indexOf("\n", pos);
      if (end === -1) end = content.length;
      const line = content.slice(pos, end);
      pos = end + 1;
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      const time = parseFloat(cols[timeIdx]);
      const price = parseFloat(cols[priceIdx]);
      if (Number.isNaN(time) || Number.isNaN(price)) continue;
      ticks.push({ time, price });
    }
    ticks.sort((a, b) => a.time - b.time);
    return ticks;
  }

  /** Build deterministic ticks from a list of prices (for tests). */
  static syntheticTicks(prices: number[], startTime = 0, stepMs = 1000): Tick[] {
    return prices.map((price, i) => ({ time: startTime + i * stepMs, price }));
  }
}
