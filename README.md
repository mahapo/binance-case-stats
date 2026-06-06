# Binance USDⓈ-M Futures — Zone-Recovery Backtester & Gutachten

A Binance-accurate futures backtesting tool built around a validated trade-math core, with a
**Zone-Recovery (CAP EA) hedging strategy** and a court-grade report ("Gutachten") that proves the
**structural fee advantage of high VIP tiers**: with identical random trades, only the fee tier
decides win vs. loss — independent of market direction.

The trade-math core (`src/models/`) reproduces Binance's official trade-export **Realized Profit**
(weighted-average-cost) and **commission** (`notional × rate`, 8-dp) to the satoshi — verified
against real account exports.

## Quick start

```bash
npm install                       # or: bun install
npm test                          # math core, strategy, charts, loaders

npm run backtest -- AVAXUSDT 2026-05               # one month: auto-download, sweep, report best
npm run backtest -- SUIUSDC 2025-10 2026-01        # a range of months (downloaded + concatenated)
npm run backtest -- SUIUSDC 2025-10-10 2025-10-12  # a range of days
```

## Scripts

| Command | What it does |
| :--- | :--- |
| `npm run download -- <SYMBOL> <PERIOD> [END]` | Download + unzip Binance aggTrades, then **slim to `price,transact_time`** and delete the zip. `PERIOD` = `YYYY-MM` (monthly) or `YYYY-MM-DD` (daily). Add an `END` of the same granularity to fetch an **inclusive range** (e.g. `SUIUSDC 2025-10 2026-01` or `SUIUSDC 2025-10-10 2025-10-12`). Cached in `data/aggTrades/`; re-runs skip. |
| `npm run backtest -- <SYMBOL> <PERIOD> [END] [limit]` | Sweep the parameter matrix (`src/settings/backtesting.ts`) over a market, auto-downloading the data. A `PERIOD` range (`<START> <END>`, same granularity) downloads and concatenates every month/day in order. Also accepts a local `<csv-path> [limit]`. |
| `npm run report -- [csv] [limit]` | Generate the zone-recovery **Gutachten** charts + numbers → `docs/zone-recovery/`. |
| `npm run fetch:brackets` | Cache real per-market leverage/position brackets from ccxt → `data/brackets/binance-usdm.json` (needs API keys in `.env`; public size limits work without keys). |

The backtest finds the best setting by net PnL, replays it across fee tiers VIP 0–9, and writes
artifacts to **`output/<SYMBOL>-<dateRange>-<bestId>/`** (the folder id carries the market, the
data's date range, and the winning params):

- `best-pnl.svg` — equity curve of the best run, with the **market price overlaid** on a secondary
  axis (title shows the market)
- `vip-fee-comparison.svg` — equity per fee tier (VIP 0–9)
- `trades.csv` — full trade log (one row per order)
- `summary.json` — market, bracket, best stats (incl. trade volume + per day), VIP comparison, all swept results

(Latest copies are also kept at `output/best-pnl.svg` and `output/vip-fee-comparison.svg`.)

## How it works (the strategy)

Zone Recovery opens a (random) long/short and, on a stop-loss, opens a larger opposite hedge at the
zone line; sizes grow geometrically until a take-profit closes the whole series. Key properties:

- **Constant gross per series** = `ratio × gap × baseQuantity`, regardless of hedge depth (proven
  invariant, locked by tests). Fees are separate.
- **Drawdown sizing** (`maxDrawdownPercent`): the first trade is sized so a fully-lost `maxSteps`
  series loses exactly that % of the live balance — so the balance never goes negative.
- **Per-market position limits**: the largest (last) hedge is capped to the market's real
  per-leverage bracket (e.g. AVAXUSDC at 75× → ≤ $5,000 notional) — the bracket is a hard limit.

## Configuration

- **Parameters swept**: edit `src/settings/backtesting.ts` (ratio, gapPercent, maxSteps,
  maxDrawdownPercent, side `0=buy 1=sell 2=random`). `vipLevel` is fixed for the sweep, then compared 0–9.
- **Leverage is per-market, not a fixed range**: the runner sweeps each market's **real bracket
  leverage rungs** (from the cache), e.g. REDUSDT → `50,25,20,10,5,4,3,2,1×`, BTCUSDC →
  `125,100,50,…`, ETHUSDT → `50,25,10,…`. So only Binance-allowed leverages run, each with its own
  position cap. The "best" is only ever a setting that actually traded.
- **Fees follow the symbol**: a `…USDC` market is charged the **USDC** fee table (0% maker, lower
  taker), a `…USDT` market the **USDT** table — auto-detected from the symbol. The **BNB −10%**
  discount is on by default (`backtestBase.bnbDiscount`). The chosen tier (and the other quote's
  rate, for contrast) is printed, drawn on the charts, and written to `summary.json`. USDC is cheaper
  than USDT at every tier — which, since the trades are identical, is the whole point.
- **API keys** (for `fetch:brackets`): `.env` with `API_KEY` / `API_SECRET` (mainnet futures,
  read-only is enough). `.env` is gitignored.

## Data

Tick CSVs are auto-detected by `PriceLoader` — Binance **trades** and **aggTrades** (with or without
a header, incl. `transact_time`), the slimmed `price,transact_time`, Gemini trade-prints, and simple
`unix,price`; times normalised to ms. Downloaded/cached data lives under `data/` (gitignored).

### data.binance.vision URL structure

```
# monthly
https://data.binance.vision/data/futures/um/monthly/aggTrades/<SYMBOL>/<SYMBOL>-aggTrades-YYYY-MM.zip
# daily
https://data.binance.vision/data/futures/um/daily/aggTrades/<SYMBOL>/<SYMBOL>-aggTrades-YYYY-MM-DD.zip
```

## Layout

- `src/models/` — `OrderFutures`, `PositionFutures`, `FeeSchedule`, `LeverageBracket` (validated core)
- `src/strategies/` — `ZoneRecovery` (geometry/sizing), `Recovery` (sequential lifecycle)
- `src/runners/` — `Backtester` (tick loop, fill simulation, metrics)
- `src/data/` — `PriceLoader`, `downloadAggTrades`, `fetchBrackets`
- `src/utils/` — `ChartExport` (dependency-free SVG charts), `Matrix`
- `docs/zone-recovery/GUTACHTEN.md` — the fee-advantage report; `docs/stats/` — the real-account report
