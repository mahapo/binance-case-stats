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

npm run backtest -- AVAXUSDT 2026-05         # auto-download a market+month, sweep, report best
```

## Scripts

| Command | What it does |
| :--- | :--- |
| `npm run download -- <SYMBOL> <PERIOD>` | Download + unzip Binance aggTrades, then **slim to `price,transact_time`** and delete the zip. `PERIOD` = `YYYY-MM` (monthly) or `YYYY-MM-DD` (daily), e.g. `AVAXUSDT 2026-05`. Cached in `data/aggTrades/`; re-runs skip. |
| `npm run backtest -- <SYMBOL> <PERIOD> [limit]` | Sweep the parameter matrix (`src/settings/backtesting.ts`) over a market, auto-downloading the data. Also accepts a local `<csv-path> [limit]`. |
| `npm run report -- [csv] [limit]` | Generate the zone-recovery **Gutachten** charts + numbers → `docs/zone-recovery/`. |
| `npm run fetch:brackets` | Cache real per-market leverage/position brackets from ccxt → `data/brackets/binance-usdm.json` (needs API keys in `.env`; public size limits work without keys). |

The backtest finds the best setting by net PnL, replays it across fee tiers VIP 0–9, and writes
artifacts to **`output/<SYMBOL>-<bestId>/`**:

- `best-pnl.svg` — equity curve of the best run (title shows the market)
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

- **Parameters swept**: edit `src/settings/backtesting.ts` (leverage, ratio, gapPercent, maxSteps,
  maxDrawdownPercent, side `0=buy 1=sell 2=random`). `vipLevel` is fixed for the sweep, then compared 0–9.
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
