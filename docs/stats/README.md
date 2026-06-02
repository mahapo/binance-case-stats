# docs/stats — Court-Grade Futures Analysis

Statistically rigorous analysis of the Binance **USD-M futures** trading account, intended as a
defensible expert report (*Gutachten*). The engine lives in **`src/stats/`** (TypeScript) and reads
the official Binance exports from **`account/futures/USD-M/`**.

Public repository (code + raw data, fully reproducible): **https://github.com/mahapo/binance-case-stats**.
Built with the assistance of **Claude Opus 4.8** (Anthropic); every analytic statistic is independently
cross-validated against SciPy (`npm run stats:validate`).

## What's here

| File | Description |
| :--- | :--- |
| `GUTACHTEN.md` / `.html` / `.pdf` | The German expert report. Defensible core + clearly-labeled illustrative appendix. |
| `analysis_data.json` | All metrics, sequences and histograms (position- and order-level). |
| `computed_values.json` | Inferential statistics: bootstrap & Wilson CI, **exact binomial (overall + per year)**, Monte-Carlo & runs-test p-values, **Ljung-Box autocorrelation**, **χ² streak fit**, plus plot-ready histograms. |
| `monthly.csv` | Per-month breakdown for spreadsheet inspection. |
| `img/*.png` | All charts embedded in the report (`binance_screenshot.png` is the original account evidence, not generated). |
| `streaks/loss_streak_<1-3>.csv` | Every fill (all original columns + position/streak annotations) for the 3 longest loss streaks, from the last winning position before each streak to the first winning position after. |
| `streaks/loss_streaks_top3.csv` | The same, combined into one file (`streak_rank` column). |

## How to reproduce

```bash
# 1) Engine — TypeScript via ts-node (no external deps): metrics, reconciliation, position
#    reconstruction, execution profile, liquidations AND all inferential statistics.
npm run stats              # -> docs/stats/{analysis_data.json, computed_values.json, monthly.csv}

# (optional) Prove the fill->order grouping is correct + cross-validate vs Binance orders/
npm run stats:verify       # add an Order ID: npm run stats:verify -- 111147095130

# (optional) Export the 3 longest loss streaks with all fills -> docs/stats/streaks/
npm run stats:streaks

# 2) Charts — pure rendering from the JSON above (Python: matplotlib, numpy)
npm run stats:charts       # -> docs/stats/img/*.png

# 3) Build the PDF (markdown -> HTML -> PDF via headless Chrome)
npm run stats:report       # -> docs/stats/GUTACHTEN.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf="$PWD/docs/stats/GUTACHTEN.pdf" \
  "file://$PWD/docs/stats/GUTACHTEN.html"
```

**`GUTACHTEN.pdf`** is the print-ready report (A4, all charts embedded).

```bash
# (optional) Independently cross-check every analytic statistic against SciPy
npm run stats:validate     # asserts computed_values.json == scipy recomputation
```

All statistics are computed once in TypeScript (`src/stats/significance.ts`, analytic p-values via the
standard normal/χ²/t routines in `src/stats/mathx.ts`); Python only renders. The random seed is fixed
(`20260601`, mulberry32), so the Monte-Carlo and bootstrap figures are reproducible. **`stats:validate`
re-derives the runs test, exact binomial (overall + per year), t-test, Wilson CI, Ljung-Box and the
conditional χ² with SciPy and confirms agreement to machine precision** — the from-scratch numerics are
not taken on trust.

## Headline results

- **Net trading result: −$77,633.14**, reconciling to Binance's reported −$78,046.59 within **0.53 %**.
- Gross result before costs: **+$349.61**. Fees/levies: **−$77,982.75** = **223×** the gross result
  (≈ 5.08 bps of ~$153.6M traded notional).
- **99.8 % of commission was taker fees** (90,610 taker vs 113 maker fills); commission rate **3.90 bps**
  ≈ Binance's standard taker rate → the rate was *not* inflated; the burden is structural (all-taker
  execution × high churn/leverage).
- **367 forced liquidations** (−$15,063), concentrated in 2021 (146).
- Execution: 16,798 market / 11,363 stop-market / 653 limit orders. **Stops triggered only 8 of 11,373
  (0.07 %)** → *refutes* a stop-hunting theory; **94 % of exits were discretionary market orders.**
- **Analysis unit = economic position** (open→flat cycle), reconstructed from fills, to avoid
  counting partial closes as separate trades. 6,367 closing orders → **5,813 positions**.
- Win rate **29.04 %** (Wilson 95 % CI 27.89–30.22 %) vs **33.43 %** breakeven implied by the
  realized 1:1.99 reward/risk → significantly below breakeven. **Exact binomial p ≈ 3.9×10⁻¹³**
  (overall); individually significant in 2021, 2023, 2024 and 2025.
- Per-position mean −$10.23 but **bootstrap 95 % CI [−$26, +$8]** (t-test p = 0.24) → a negative
  *per-trade* edge is **not** statistically established; the loss is driven by fees + the win/loss
  frequency, not a significant negative mean.
- Longest loss streak **32 positions**; Monte-Carlo **p = 0.004** under a *fair market* (R:R-implied
  33.43 % breakeven win rate); p = 0.029 under the trader's own loss rate (robustness).
- **Runs test z = −11.10, p ≈ 1.3×10⁻²⁸**; **Ljung-Box Q₂₀ = 317, p < 0.001**; **conditional χ²
  streak-length fit χ² = 289, df = 11, p < 0.001** → outcomes are strongly clustered / serially
  dependent, i.e. **not** a fair independent random process. (Limitation stated openly in the report:
  the time-varying yearly win rate contributes to the measured dependence.)
- **Robustness (order vs position):** win rate 31.84 %→29.04 %, max loss streak 29→32 — the streak
  finding survives the unit definition (the order-level 29 was partly inflated by partial closes).
- **Data integrity:** the engine's fill→order grouping reproduces Binance's own `orders/` ledger over
  the full 2020–2025 period (17,341 vs 17,342 orders, 99.99 % match, 0 collisions; all 6,367 closing
  orders matched 100 %).

## Methodological note (important for court use)

The report deliberately separates **deterministic accounting facts** (the fee burden — unassailable)
from **statistical patterns** (win rate, streaks, non-independence — quantified with standard tests).
Claims that an opposing expert could rebut — kurtosis-as-manipulation, streaks-vs-fair-coin,
win-rate-proves-exchange-edge — are confined to **Appendix A** with explicit caveats, and the
limitations (order- vs. position-level granularity, causation) are stated in **Appendix B**.
