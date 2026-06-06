import * as fs from "fs";
import * as path from "path";
import * as ccxt from "ccxt";
import { BracketTier, SymbolLimits } from "../models/LeverageBracket";

// Fetches Binance USDⓈ-M leverage/position brackets for every market via ccxt and
// caches them to data/brackets/binance-usdm.json, so the backtester can apply the
// correct per-market position limit offline (the bracket endpoint is private).
//
//   npm run fetch:brackets
//
// Reads API keys from .env (API_KEY/API_SECRET, or BINANCE_API_KEY/_SECRET).

export const CACHE_PATH = path.resolve(process.cwd(), "data/brackets/binance-usdm.json");

// Minimal .env loader (no dependency): KEY=VALUE lines, sets unset vars only.
function loadEnv(): void {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[m[1]] == null) process.env[m[1]] = val;
  }
}

/** ccxt unified symbol → compact upper (e.g. "AVAX/USDC:USDC" → "AVAXUSDC"). */
export const compactSymbol = (s: string): string =>
  s.split(":")[0].replace("/", "").toUpperCase();

/**
 * Pure mapping from ccxt `fetchLeverageTiers()` output to our per-symbol
 * BracketTier[] cache (ascending by maxNotional). Unit-testable without network.
 */
export function bracketsFromCcxtTiers(
  tiers: Record<string, any[]>
): Record<string, BracketTier[]> {
  const out: Record<string, BracketTier[]> = {};
  for (const [sym, list] of Object.entries(tiers)) {
    const mapped: BracketTier[] = (list ?? [])
      .map((t) => ({
        maxNotional: Number(t.maxNotional),
        maxLeverage: Number(t.maxLeverage),
        mmr: Number(t.maintenanceMarginRate),
        maintAmount: Number(t.info?.cum ?? t.info?.cumFast ?? 0),
      }))
      .filter((b) => Number.isFinite(b.maxNotional) && Number.isFinite(b.maxLeverage) && b.maxLeverage > 0)
      .sort((a, b) => a.maxNotional - b.maxNotional);
    if (mapped.length) out[compactSymbol(sym)] = mapped;
  }
  return out;
}

/** Public per-market size limits from ccxt `loadMarkets()` (USDⓈ-M linear only). */
export function limitsFromMarkets(markets: Record<string, any>): Record<string, SymbolLimits> {
  const out: Record<string, SymbolLimits> = {};
  for (const m of Object.values(markets)) {
    if (!m?.contract || !m?.linear || m?.settle !== "USDT" && m?.settle !== "USDC") continue;
    const lim = m.limits ?? {};
    out[compactSymbol(m.symbol)] = {
      maxPositionQty: lim.amount?.max ?? undefined,
      maxOrderQty: lim.market?.max ?? undefined,
    };
  }
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  const apiKey = process.env.API_KEY ?? process.env.BINANCE_API_KEY;
  const secret = process.env.API_SECRET ?? process.env.BINANCE_API_SECRET;

  const ex = new (ccxt as any).binance({
    apiKey,
    secret,
    options: { defaultType: "future" },
    enableRateLimit: true,
  });

  // Public: per-market size limits (works without keys).
  console.log("Loading markets (public) …");
  await ex.loadMarkets();
  const limits = limitsFromMarkets(ex.markets);
  console.log(`Public limits for ${Object.keys(limits).length} USDⓈ-M markets.`);

  // Private: per-leverage notional brackets (needs valid keys; best-effort).
  let brackets: Record<string, BracketTier[]> = {};
  if (apiKey && secret) {
    try {
      console.log("Fetching leverage tiers (private endpoint) …");
      brackets = bracketsFromCcxtTiers(await ex.fetchLeverageTiers());
      console.log(`Private brackets for ${Object.keys(brackets).length} symbols.`);
    } catch (e: any) {
      console.warn(`Leverage-bracket fetch failed (${e?.message ?? e}). Caching public limits only.`);
    }
  } else {
    console.warn("No API keys — caching public size limits only (per-leverage brackets need keys).");
  }

  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        source: "binance ccxt loadMarkets (public limits) + fetchLeverageTiers (private brackets)",
        brackets,
        limits,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${CACHE_PATH}`);
  for (const s of ["BTCUSDT", "AVAXUSDC", "ETHUSDT"]) {
    const b = brackets[s] ? brackets[s].map((x) => `${x.maxLeverage}x≤$${x.maxNotional}`).join(" · ") : "—";
    console.log(`  ${s}: maxPositionQty ${limits[s]?.maxPositionQty ?? "?"} · brackets ${b}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
