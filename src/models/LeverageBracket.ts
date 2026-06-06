// Binance USDⓈ-M leverage & margin brackets (position limits).
//
// As a position's notional ("Position Value") grows, the maximum allowed
// leverage drops and the maintenance-margin rate rises. So a chosen leverage
// implies a maximum position value: the largest bracket whose Max Leverage still
// permits that leverage. e.g. 150× → ≤ 300,000 USDT; 100× → ≤ 800,000; 75× → ≤
// 3,000,000; 50× → ≤ 12,000,000.
//
// Brackets are PER MARKET (BTCUSDT ≠ AVAXUSDC). Use `LeverageBracket.forSymbol()`
// to load a market's real brackets from the ccxt-fetched cache
// (`data/brackets/binance-usdm.json`, populated by `npm run fetch:brackets`).
// The BTCUSDT table below is a built-in fallback.
//   Maintenance Margin = Position Value × MMR − Maintenance Amount.

import * as fs from "fs";
import * as path from "path";

export interface BracketTier {
  /** Upper bound of the position bracket (Position Value in USDT). */
  maxNotional: number;
  maxLeverage: number;
  /** Maintenance Margin Rate (decimal, e.g. 0.004 = 0.40%). */
  mmr: number;
  /** Maintenance Amount (USDT) — the bracket's cumulative deduction. */
  maintAmount: number;
}

/** Public per-market size limits from ccxt `loadMarkets()` (base asset). */
export interface SymbolLimits {
  maxPositionQty?: number; // limits.amount.max — max position size
  maxOrderQty?: number; // limits.market.max — max single market order
}

// BTCUSDT Perpetual brackets, ascending by notional.
export const BTCUSDT_BRACKETS: BracketTier[] = [
  { maxNotional: 300_000, maxLeverage: 150, mmr: 0.004, maintAmount: 0 },
  { maxNotional: 800_000, maxLeverage: 100, mmr: 0.005, maintAmount: 300 },
  { maxNotional: 3_000_000, maxLeverage: 75, mmr: 0.0065, maintAmount: 1_500 },
  { maxNotional: 12_000_000, maxLeverage: 50, mmr: 0.01, maintAmount: 12_000 },
  { maxNotional: 70_000_000, maxLeverage: 25, mmr: 0.02, maintAmount: 132_000 },
  { maxNotional: 100_000_000, maxLeverage: 20, mmr: 0.025, maintAmount: 482_000 },
  { maxNotional: 230_000_000, maxLeverage: 10, mmr: 0.05, maintAmount: 2_982_000 },
  { maxNotional: 480_000_000, maxLeverage: 5, mmr: 0.1, maintAmount: 14_482_000 },
  { maxNotional: 600_000_000, maxLeverage: 4, mmr: 0.125, maintAmount: 26_482_000 },
  { maxNotional: 800_000_000, maxLeverage: 3, mmr: 0.15, maintAmount: 41_482_000 },
  { maxNotional: 1_200_000_000, maxLeverage: 2, mmr: 0.25, maintAmount: 121_482_000 },
  { maxNotional: 1_800_000_000, maxLeverage: 1, mmr: 0.5, maintAmount: 421_482_000 },
];

export type BracketCache = Record<string, BracketTier[]>;
interface CacheEnvelope {
  brackets: BracketCache;
  limits: Record<string, SymbolLimits>;
}

// Default on-disk cache written by `npm run fetch:brackets`.
const CACHE_FILE = path.resolve(process.cwd(), "data/brackets/binance-usdm.json");
let _cache: CacheEnvelope | null = null;

function loadCache(): CacheEnvelope {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    _cache = {
      brackets: (raw.brackets ?? raw ?? {}) as BracketCache,
      limits: (raw.limits ?? {}) as Record<string, SymbolLimits>,
    };
  } catch {
    _cache = { brackets: {}, limits: {} };
  }
  return _cache;
}

/** ccxt/exchange symbol → compact upper, e.g. "AVAX/USDC:USDC" → "AVAXUSDC". */
const compact = (s: string): string =>
  s.split(":")[0].replace("/", "").toUpperCase();

const candidatesFor = (norm: string): string[] => {
  const c = [norm];
  if (norm.endsWith("USDC")) c.push(norm.slice(0, -4) + "USDT");
  if (norm.endsWith("USDT")) c.push(norm.slice(0, -4) + "USDC");
  if (norm.endsWith("USD")) c.push(norm + "T", norm + "C");
  return c;
};

export class LeverageBracket {
  constructor(
    readonly tiers: BracketTier[] = BTCUSDT_BRACKETS,
    readonly limits: SymbolLimits = {}
  ) {}

  /**
   * Per-market position limits for a symbol, from the ccxt-fetched cache:
   * per-leverage notional brackets (private endpoint) and/or the public position
   * size limit (`maxPositionQty`). Falls back USDC↔USDT and …USD→…USDT/…USDC (so
   * Gemini spot files map to a USDⓈ-M market), then to the built-in BTCUSDT table
   * for BTC, then to an uncapped tier. Pass `{ cache, limits }` to inject (tests).
   */
  static forSymbol(
    symbol: string,
    opts: {
      cache?: BracketCache;
      limits?: Record<string, SymbolLimits>;
      warnOnFallback?: boolean;
    } = {}
  ): LeverageBracket {
    const env: CacheEnvelope =
      opts.cache || opts.limits
        ? { brackets: opts.cache ?? {}, limits: opts.limits ?? {} }
        : loadCache();
    const candidates = candidatesFor(compact(symbol));

    let tiers: BracketTier[] | undefined;
    let lim: SymbolLimits | undefined;
    for (const c of candidates) if (env.brackets[c]?.length) { tiers = env.brackets[c]; break; }
    for (const c of candidates) if (env.limits[c]) { lim = env.limits[c]; break; }

    if (!tiers) {
      if (compact(symbol).startsWith("BTC")) tiers = BTCUSDT_BRACKETS;
      else {
        tiers = [{ maxNotional: Infinity, maxLeverage: Infinity, mmr: 0, maintAmount: 0 }];
        // Only warn if we have NO real limit at all (no brackets and no qty cap).
        if (!lim?.maxPositionQty && opts.warnOnFallback !== false) {
          console.warn(
            `LeverageBracket: no brackets/limits for "${symbol}" — uncapped (run npm run fetch:brackets)`
          );
        }
      }
    }
    return new LeverageBracket(tiers, lim ?? {});
  }

  /** Reset the memoized on-disk cache (tests). */
  static _resetCache(): void {
    _cache = null;
  }

  /**
   * Maximum base-asset quantity for a single position at this leverage/price —
   * the tighter of the per-leverage notional bracket and the public position
   * size limit. (Used to cap the largest hedge of a recovery series.)
   */
  maxBaseQty(price: number, leverage: number): number {
    const byNotional =
      price > 0 ? this.maxPositionValue(leverage) / price : Infinity;
    const byQty = this.limits.maxPositionQty ?? Infinity;
    return Math.min(byNotional, byQty);
  }

  /**
   * Maximum position value (notional, USDT) tradable at a given leverage — the
   * largest bracket whose Max Leverage ≥ leverage. Returns 0 if the leverage
   * exceeds every bracket's limit (i.e. it isn't allowed at all).
   */
  maxPositionValue(leverage: number): number {
    let max = 0;
    for (const t of this.tiers) if (t.maxLeverage >= leverage) max = t.maxNotional;
    return max;
  }

  /**
   * Highest leverage the market allows (max over all brackets). Above this no
   * position can open (`maxPositionValue` → 0). `Infinity` for the uncapped
   * fallback (unknown symbols).
   */
  maxLeverage(): number {
    let max = 0;
    for (const t of this.tiers) if (t.maxLeverage > max) max = t.maxLeverage;
    return max;
  }

  /**
   * Distinct leverage rungs to sweep for this market — the Max Leverage of each
   * bracket tier, descending (e.g. REDUSDT → 50, 25, 20, 10, 5, 4, 3, 2, 1).
   * These are exactly the leverages Binance permits, each with its own position
   * cap. Falls back to a sensible default when the bracket is uncapped (an
   * unknown symbol with no cached brackets).
   */
  leverageRungs(): number[] {
    const finite = this.tiers
      .map((t) => t.maxLeverage)
      .filter((l) => Number.isFinite(l) && l > 0);
    const uniq = Array.from(new Set(finite)).sort((a, b) => b - a);
    return uniq.length ? uniq : [75, 50, 25, 10, 5]; // uncapped fallback
  }

  /** The bracket a given position value falls into. */
  tierFor(positionValue: number): BracketTier {
    for (const t of this.tiers) if (positionValue <= t.maxNotional) return t;
    return this.tiers[this.tiers.length - 1];
  }

  maintenanceMarginRate(positionValue: number): number {
    return this.tierFor(positionValue).mmr;
  }

  maintenanceAmount(positionValue: number): number {
    return this.tierFor(positionValue).maintAmount;
  }

  /** Maintenance Margin = Position Value × MMR − Maintenance Amount. */
  maintenanceMargin(positionValue: number): number {
    const t = this.tierFor(positionValue);
    return positionValue * t.mmr - t.maintAmount;
  }
}
