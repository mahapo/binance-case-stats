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
//   npm run download -- <SYMBOL> <PERIOD> [END_PERIOD]
//     PERIOD = YYYY-MM (monthly)  or  YYYY-MM-DD (daily)
//   npm run download -- AVAXUSDT 2026-05
//   npm run download -- AVAXUSDT 2025-10-12
//   npm run download -- SUIUSDC 2025-10 2026-01      (range of months)
//   npm run download -- SUIUSDC 2025-10-10 2025-10-12 (range of days)

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
 * Expand an inclusive period range into its ordered list of periods. Both ends
 * must share a granularity — months (YYYY-MM) or days (YYYY-MM-DD).
 *   expandPeriods("2025-10","2026-01")   → ["2025-10","2025-11","2025-12","2026-01"]
 *   expandPeriods("2025-10-10","2025-10-12") → ["2025-10-10","2025-10-11","2025-10-12"]
 */
export function expandPeriods(start: string, end: string): string[] {
  if (start === end) return [start];
  const months = MONTH_RE.test(start) && MONTH_RE.test(end);
  const days = DAY_RE.test(start) && DAY_RE.test(end);
  if (!months && !days) {
    throw new Error(
      `period range must be two months (YYYY-MM) or two days (YYYY-MM-DD): got "${start}" … "${end}"`
    );
  }
  const out: string[] = [];
  if (months) {
    let [y, m] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    if (y > ey || (y === ey && m > em)) {
      throw new Error(`period range start "${start}" is after end "${end}"`);
    }
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    const s = new Date(`${start}T00:00:00Z`);
    const e = new Date(`${end}T00:00:00Z`);
    if (s.getTime() > e.getTime()) {
      throw new Error(`period range start "${start}" is after end "${end}"`);
    }
    for (let d = s; d.getTime() <= e.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
  }
  return out;
}

/** Download (cached, skipping present) every period in an inclusive range; ordered CSV paths. */
export async function downloadAggTradesRange(
  symbol: string,
  start: string,
  end: string = start,
  opts: { dir?: string } = {}
): Promise<string[]> {
  const periods = expandPeriods(start, end);
  const csvs: string[] = [];
  for (const p of periods) csvs.push(await downloadAggTrades(symbol, p, opts));
  return csvs;
}

/**
 * Resolve a runner's CLI args into ordered tick CSV(s) + a tick limit. Supports:
 *   <SYMBOL> <PERIOD> [limit]           → one month/day (e.g. AVAXUSDT 2026-05)
 *   <SYMBOL> <START> <END> [limit]      → inclusive range, same granularity
 *                                         (e.g. SUIUSDC 2025-10 2026-01)
 *   <csv-path> [limit]                  → a local file
 *   (none)                              → defaultCsv
 */
export async function resolveData(
  argv: string[],
  defaults: { defaultCsv: string; defaultLimit: number }
): Promise<{ csvs: string[]; limit: number; label: string }> {
  const a = argv[2];
  const b = argv[3];
  const c = argv[4];
  const d = argv[5];
  if (a && b && isSymbol(a) && isPeriod(b)) {
    // argv[4] is an end period when it looks like one (range), else the limit.
    const hasEnd = !!c && isPeriod(c);
    const start = b;
    const end = hasEnd ? c : b;
    const limitArg = hasEnd ? d : c;
    const csvs = await downloadAggTradesRange(a, start, end);
    const sym = a.toUpperCase();
    const label = start === end ? `${sym} ${start}` : `${sym} ${start}…${end}`;
    return {
      csvs,
      limit: limitArg ? parseInt(limitArg, 10) : defaults.defaultLimit,
      label,
    };
  }
  const csv = a || defaults.defaultCsv;
  return {
    csvs: [csv],
    limit: b ? parseInt(b, 10) : defaults.defaultLimit,
    label: path.basename(csv),
  };
}

async function main(): Promise<void> {
  const [, , symbol, start, end] = process.argv;
  if (!symbol || !start || !isSymbol(symbol) || !isPeriod(start) || (end && !isPeriod(end))) {
    console.error(
      "Usage: npm run download -- <SYMBOL> <YYYY-MM | YYYY-MM-DD> [END_PERIOD]"
    );
    process.exit(1);
  }
  const csvs = await downloadAggTradesRange(symbol, start, end || start);
  console.log(`Ready ${csvs.length} file(s).`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
