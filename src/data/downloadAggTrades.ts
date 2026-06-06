import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// Downloads Binance USDⓈ-M futures aggTrades dumps (monthly or daily) from
// data.binance.vision, unzips once (deleting the .zip), and slims the CSV to the
// only columns the backtester needs — `price,transact_time` — caching it under
// data/aggTrades/. Re-runs skip if the slimmed CSV is already present.
//
//   npm run download -- <SYMBOL> <PERIOD>
//     PERIOD = YYYY-MM (monthly)  or  YYYY-MM-DD (daily)
//   npm run download -- AVAXUSDT 2026-05
//   npm run download -- AVAXUSDT 2025-10-12

export const DOWNLOAD_DIR = path.resolve(process.cwd(), "data/aggTrades");

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isPeriod = (s: string) => MONTH_RE.test(s) || DAY_RE.test(s);
export const isSymbol = (s: string) =>
  /^[A-Z0-9]{3,}USD[TC]?$/i.test(s) && !s.includes("/") && !s.includes(".");

/** data.binance.vision URL for a symbol + period (monthly or daily aggTrades). */
export function aggTradesUrl(symbol: string, period: string): string {
  const sym = symbol.toUpperCase();
  const kind = MONTH_RE.test(period) ? "monthly" : "daily";
  if (kind === "daily" && !DAY_RE.test(period)) {
    throw new Error(`Invalid period "${period}" (use YYYY-MM or YYYY-MM-DD)`);
  }
  return `https://data.binance.vision/data/futures/um/${kind}/aggTrades/${sym}/${sym}-aggTrades-${period}.zip`;
}

/**
 * Rewrite an aggTrades CSV down to the only columns the backtester uses —
 * `price,transact_time` — dropping agg_trade_id, quantity, first_trade_id,
 * last_trade_id and is_buyer_maker to save disk. Streams (handles GB files).
 */
async function slimCsv(csvPath: string): Promise<void> {
  const tmp = csvPath + ".slim";
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity,
  });
  const out = fs.createWriteStream(tmp);
  out.write("price,transact_time\n");
  let priceIdx = 1;
  let timeIdx = 5; // aggTrades default layout
  let first = true;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split(",");
    if (first) {
      first = false;
      const lower = cols.map((c) => c.toLowerCase());
      const pi = lower.indexOf("price");
      const ti = lower.findIndex(
        (h) => h === "unix" || h === "timestamp" || h.endsWith("time")
      );
      if (pi >= 0 && ti >= 0) {
        priceIdx = pi;
        timeIdx = ti;
        continue; // header row → skip
      }
      // Headerless: price is col 1, time is the ms-epoch column.
      const epochIdx = cols.findIndex((c) => /^\d{13,}$/.test(c.trim()));
      if (epochIdx >= 0) timeIdx = epochIdx;
      // fall through — first line is data
    }
    if (cols.length > Math.max(priceIdx, timeIdx)) {
      out.write(cols[priceIdx] + "," + cols[timeIdx] + "\n");
    }
  }
  out.end();
  await new Promise<void>((res) => out.on("finish", () => res()));
  fs.renameSync(tmp, csvPath);
}

/**
 * Ensure the aggTrades CSV for symbol+period is present locally (downloading and
 * unzipping once if needed); returns the CSV path. The cached CSV is slimmed to
 * `price,transact_time`.
 */
export async function downloadAggTrades(
  symbol: string,
  period: string,
  opts: { dir?: string } = {}
): Promise<string> {
  const sym = symbol.toUpperCase();
  const dir = opts.dir ?? DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${sym}-aggTrades-${period}`;
  const csvPath = path.join(dir, `${stem}.csv`);
  const zipPath = path.join(dir, `${stem}.zip`);

  if (fs.existsSync(csvPath)) {
    console.log(`Using cached ${csvPath}`);
    return csvPath;
  }

  if (!fs.existsSync(zipPath)) {
    const url = aggTradesUrl(sym, period);
    console.log(`Downloading ${url} …`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(
        `Download failed (${res.status} ${res.statusText}) for ${url}` +
          (res.status === 404 ? " — symbol/period not available on data.binance.vision" : "")
      );
    }
    const tmp = zipPath + ".part";
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
    fs.renameSync(tmp, zipPath);
    console.log(`Saved ${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB → ${zipPath}`);
  }

  console.log(`Unzipping ${zipPath} …`);
  execSync(`unzip -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(dir)}`, {
    stdio: "ignore",
  });
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Unzip did not produce ${csvPath}`);
  }
  fs.rmSync(zipPath, { force: true }); // drop the zip once unzipped to save space
  console.log(`Slimming to price,transact_time …`);
  await slimCsv(csvPath);
  console.log(`Ready: ${csvPath} (${(fs.statSync(csvPath).size / 1e6).toFixed(1)} MB)`);
  return csvPath;
}

/**
 * Resolve a runner's CLI args into a tick CSV + tick limit. Supports:
 *   <SYMBOL> <PERIOD> [limit]   → auto-download (e.g. AVAXUSDT 2026-05)
 *   <csv-path> [limit]          → use a local file
 *   (none)                      → defaultCsv
 */
export async function resolveData(
  argv: string[],
  defaults: { defaultCsv: string; defaultLimit: number }
): Promise<{ csv: string; limit: number }> {
  const a = argv[2];
  const b = argv[3];
  const c = argv[4];
  if (a && b && isSymbol(a) && isPeriod(b)) {
    const csv = await downloadAggTrades(a, b);
    return { csv, limit: c ? parseInt(c, 10) : defaults.defaultLimit };
  }
  return {
    csv: a || defaults.defaultCsv,
    limit: b ? parseInt(b, 10) : defaults.defaultLimit,
  };
}

async function main(): Promise<void> {
  const [, , symbol, period] = process.argv;
  if (!symbol || !period || !isSymbol(symbol) || !isPeriod(period)) {
    console.error("Usage: npm run download -- <SYMBOL> <YYYY-MM | YYYY-MM-DD>");
    process.exit(1);
  }
  await downloadAggTrades(symbol, period);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
