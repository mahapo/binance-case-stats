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
   * Load ticks from a CSV. Auto-detects the columns, so it handles:
   *   - the Binance official trades export with a header
   *     (`id,price,qty,quote_qty,time,is_buyer_maker`, `time` in ms),
   *   - the same dump WITHOUT a header (Binance monthly files start at row 0),
   *   - the trade-prints format (`…,unix,price,…`) and the simple `unix,price`.
   * Times are normalised to milliseconds. Returns ticks sorted ascending by
   * time. Pass `limit` to read only the first N ticks (the export is already
   * chronological) — useful for big files.
   */
  static loadTicks(csvPath: string, limit = Infinity): Tick[] {
    const fd = fs.openSync(csvPath, "r");
    try {
      const CHUNK = 1 << 20; // 1 MiB
      const buf = Buffer.allocUnsafe(CHUNK);
      const ticks: Tick[] = [];

      let leftover = "";
      let firstLine = true;
      let priceIdx = -1;
      let timeIdx = -1;
      let bom = true;

      const parseDataLine = (line: string) => {
        if (!line.trim()) return;
        const cols = parseCsvLine(line);
        let time = parseFloat(cols[timeIdx]);
        const price = parseFloat(cols[priceIdx]);
        if (Number.isNaN(time) || Number.isNaN(price)) return;
        if (time < 1e12) time *= 1000; // normalise seconds → milliseconds
        ticks.push({ time, price });
      };

      // Resolve columns from the first line; returns false if it's a header to skip.
      const resolveColumns = (line: string): boolean => {
        const cols = parseCsvLine(line);
        const lower = cols.map((h) => h.toLowerCase());
        timeIdx = lower.findIndex(
          (h) => h === "unix" || h === "time" || h === "timestamp"
        );
        priceIdx = lower.indexOf("price");
        if (timeIdx !== -1 && priceIdx !== -1) return false; // header row → skip

        // No header — assume Binance trades layout id,price,qty,quote_qty,time,…
        const price = Number(cols[1]);
        const time = Number(cols[4]);
        if (cols.length >= 5 && price > 0 && Number.isFinite(time) && time > 1e11) {
          priceIdx = 1;
          timeIdx = 4;
          return true; // this line is data
        }
        throw new Error(
          `PriceLoader: could not find time/price columns in ${csvPath}`
        );
      };

      let bytesRead: number;
      outer: while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
        let chunk = buf.toString("utf8", 0, bytesRead);
        if (bom) {
          chunk = chunk.replace(/^﻿/, "");
          bom = false;
        }
        const data = leftover + chunk;
        let start = 0;
        let nl: number;
        while ((nl = data.indexOf("\n", start)) !== -1) {
          const line = data.slice(start, nl);
          start = nl + 1;
          if (firstLine) {
            firstLine = false;
            if (!resolveColumns(line)) continue; // header → skip
          }
          parseDataLine(line);
          if (ticks.length >= limit) break outer;
        }
        leftover = data.slice(start);
      }

      // Trailing line with no final newline.
      if (ticks.length < limit && leftover.length > 0) {
        if (firstLine) {
          if (resolveColumns(leftover)) parseDataLine(leftover); // headerless single line
        } else {
          parseDataLine(leftover);
        }
      }

      ticks.sort((a, b) => a.time - b.time);
      return ticks;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Build deterministic ticks from a list of prices (for tests). */
  static syntheticTicks(prices: number[], startTime = 0, stepMs = 1000): Tick[] {
    return prices.map((price, i) => ({ time: startTime + i * stepMs, price }));
  }
}
