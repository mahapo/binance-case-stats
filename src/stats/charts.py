#!/usr/bin/env python3
"""
Binance Futures USD-M — court report charts (rendering only).

All statistics are computed by the TypeScript engine (`npm run stats`) and written to
docs/stats/{analysis_data.json, computed_values.json}. This script is a pure renderer:
it reads those files and draws every PNG embedded in the Gutachten. No inference logic
lives here, so the report has a single source of statistical truth.

Run:  npm run stats:charts        # = python3 src/stats/charts.py
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "docs", "stats"))
IMG = os.path.join(OUT, "img")
os.makedirs(IMG, exist_ok=True)

# Consistent house style
plt.rcParams.update({
    "figure.dpi": 130,
    "savefig.dpi": 130,
    "font.size": 11,
    "axes.grid": True,
    "grid.alpha": 0.25,
    "axes.spines.top": False,
    "axes.spines.right": False,
})
C_LOSS = "#c0392b"
C_WIN = "#27ae60"
C_NEUT = "#2c3e50"
C_ACC = "#2980b9"


def eur(x):
    return f"${x:,.0f}"


def save(fig, name):
    path = os.path.join(IMG, name)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    print("  wrote img/" + name)


def bin_centers(hist):
    """Reconstruct equal-width bin centers + counts from a {min,max,counts} histogram."""
    counts = np.array(hist["counts"], dtype=float)
    edges = np.linspace(hist["min"], hist["max"], len(counts) + 1)
    centers = 0.5 * (edges[:-1] + edges[1:])
    width = edges[1] - edges[0]
    return centers, counts, width


# ---------------------------------------------------------------------------
with open(os.path.join(OUT, "analysis_data.json"), encoding="utf-8") as f:
    D = json.load(f)
with open(os.path.join(OUT, "computed_values.json"), encoding="utf-8") as f:
    C = json.load(f)

recon = D["reconciliation"]
overall = D["overall"]
seq = D["sequences"]
pnl = np.array(seq["closingPnLChrono"], dtype=float)
N = len(pnl)

ev = C["expected_value"]
wr = C["win_rate"]
mls = C["max_loss_streak"]
runs = C["runs_test"]
acor = C["autocorrelation"]
lsf = C["loss_streak_frequency"]

mean_pnl = ev["mean_pnl_per_trade"]
ci_lo, ci_hi = ev["bootstrap_ci95"]
win_rate = wr["win_rate"]
rr = wr["rr_ratio"]
breakeven_wr = wr["breakeven_win_rate_implied"]
w_lo, w_hi = wr["wilson_ci95"]
obs_max_loss_streak = mls["observed"]
fair = mls["primary_fair_rr_baseline"]
p_fair = fair["p_value_ge_observed"]

print(f"Rendering charts for {N} closing trades  |  win rate {win_rate*100:.2f}%  |  max loss streak {obs_max_loss_streak}")

# ---------------------------------------------------------------------------
# 1) Bootstrap sampling distribution of the mean per-trade P&L
# ---------------------------------------------------------------------------
centers, counts, width = bin_centers(ev["histogram"])
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.bar(centers, counts, width=width, color=C_ACC, alpha=0.75, edgecolor="white", linewidth=0.3)
# normal overlay scaled to the histogram
mu_b = float(np.average(centers, weights=counts))
var_b = float(np.average((centers - mu_b) ** 2, weights=counts))
sd_b = np.sqrt(var_b)
x = np.linspace(centers.min(), centers.max(), 400)
norm = np.exp(-0.5 * ((x - mu_b) / sd_b) ** 2) / (sd_b * np.sqrt(2 * np.pi))
ax.plot(x, norm * counts.sum() * width, color=C_NEUT, lw=1.5, label="Normalverteilungs-Näherung")
ax.axvline(0, color=C_LOSS, lw=2, ls="--", label="Gewinnschwelle (0 $)")
ax.axvspan(ci_lo, ci_hi, color=C_WIN, alpha=0.12, label="95%-Konfidenzintervall")
ax.axvline(mean_pnl, color=C_NEUT, lw=2, label=f"Mittelwert {mean_pnl:.2f} $")
ax.set_title("Erwartungswert pro Trade — Bootstrap-Stichprobenverteilung\n"
             f"Mittelwert {mean_pnl:.2f} $; 95%-KI [{ci_lo:.2f}; {ci_hi:.2f}] schließt die Null ein")
ax.set_xlabel("Mittlerer Gewinn/Verlust pro Trade (USD)")
ax.set_ylabel("Häufigkeit (Bootstrap-Stichproben)")
ax.legend(fontsize=9)
save(fig, "ev_bell_curve.png")

# ---------------------------------------------------------------------------
# 2) Wilson CI for win rate vs R:R-implied breakeven
# ---------------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(7.5, 3.2))
ax.errorbar([win_rate * 100], [0], xerr=[[(win_rate - w_lo) * 100], [(w_hi - win_rate) * 100]],
            fmt="o", color=C_ACC, capsize=6, markersize=9, lw=2,
            label=f"Trefferquote {win_rate*100:.2f}%  (95%-KI {w_lo*100:.2f}–{w_hi*100:.2f}%)")
ax.axvline(breakeven_wr * 100, color=C_LOSS, lw=2, ls="--",
           label=f"Gewinnschwelle bei CRV 1:{rr:.2f} → {breakeven_wr*100:.2f}%")
ax.set_yticks([])
ax.set_xlabel("Trefferquote (%)")
ax.set_title("Tatsächliche Trefferquote mit 95%-Konfidenzintervall (Wilson)")
ax.legend(fontsize=9, loc="lower center", bbox_to_anchor=(0.5, -0.55))
save(fig, "winrate_ci.png")

# ---------------------------------------------------------------------------
# 3) Monte-Carlo max loss streak under a fair (R:R-implied) market
# ---------------------------------------------------------------------------
mc_hist = {int(k): int(v) for k, v in fair["histogram"].items()}
ks_mc = np.arange(min(mc_hist), max(max(mc_hist), obs_max_loss_streak) + 1)
mc_counts = np.array([mc_hist.get(int(k), 0) for k in ks_mc], dtype=float)
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.bar(ks_mc, mc_counts, width=0.9, color=C_ACC, alpha=0.8, edgecolor="white", linewidth=0.3,
       label=f"Simulierte längste Verlustserie\n(faire Gewinnschwelle {breakeven_wr*100:.1f}% bei CRV 1:{rr:.2f}, {mls['n_sims']:,} Sim.)")
ax.axvline(obs_max_loss_streak, color=C_LOSS, lw=2.5,
           label=f"Beobachtet: {obs_max_loss_streak} Verluste in Folge")
ax.axvline(fair["median_max_streak"], color=C_NEUT, lw=1.5, ls="--",
           label=f"Median Simulation: {fair['median_max_streak']:.0f}")
ax.set_title("Längste Verlustserie — Monte-Carlo unter einem fairen Markt (CRV-Gewinnschwelle)\n"
             f"p(≥{obs_max_loss_streak}) = {p_fair:.3f}  (Einheit: wirtschaftliche Position, n={N:,})")
ax.set_xlabel("Längste Verlustserie in einer simulierten Handelshistorie")
ax.set_ylabel("Anzahl Simulationen")
ax.legend(fontsize=9)
save(fig, "maxstreak_montecarlo.png")

# ---------------------------------------------------------------------------
# 4) Observed vs expected loss-streak frequency
# ---------------------------------------------------------------------------
ks = np.array(lsf["lengths"], dtype=float)
observed = np.array(lsf["observed"], dtype=float)
exp_fair = np.array(lsf["expected_fair_geometric"], dtype=float)
fig, ax = plt.subplots(figsize=(9, 4.8))
wbar = 0.4
ax.bar(ks - wbar / 2, observed, width=wbar, color=C_LOSS, label="Beobachtet (Positionen)")
ax.bar(ks + wbar / 2, exp_fair, width=wbar, color=C_ACC,
       label=f"Erwartet bei fairem Markt (geometrisch, Verlustquote {(1-breakeven_wr)*100:.1f}%, CRV 1:{rr:.2f})")
ax.set_yscale("symlog", linthresh=1)
cf = lsf["chi_square_fit"]
ax.set_title("Verlustserien: beobachtete vs. bei fairem Markt erwartete Längenverteilung\n"
             f"χ²-Anpassungstest (bedingt auf {cf['nRuns']:.0f} Verlustserien): χ² = {cf['chi2']:.0f}, df = {cf['df']}, p < 0,001")
ax.set_xlabel("Länge der Verlustserie (aufeinanderfolgende Verluste, Positionsebene)")
ax.set_ylabel("Anzahl (symlog)")
ax.legend(fontsize=9)
save(fig, "streak_freq_observed_vs_expected.png")

# ---------------------------------------------------------------------------
# 4b) NEW — autocorrelation of the win/loss sequence (independence finding)
# ---------------------------------------------------------------------------
acf = np.array(acor["acf"], dtype=float)
lags = np.arange(1, len(acf) + 1)
conf = 1.959963985 / np.sqrt(N)  # ~95% white-noise band
fig, ax = plt.subplots(figsize=(9, 4.4))
ax.bar(lags, acf, width=0.6, color=C_NEUT)
ax.axhline(conf, color=C_LOSS, ls="--", lw=1, label=f"95%-Signifikanzband (±{conf:.3f})")
ax.axhline(-conf, color=C_LOSS, ls="--", lw=1)
ax.axhline(0, color="black", lw=0.7)
ax.set_xticks(lags)
ax.set_title("Autokorrelation der Gewinn/Verlust-Folge (1 = Gewinn, 0 = Verlust)\n"
             f"Ljung-Box Q({acor['max_lag']}) = {acor['ljung_box_Q']:.0f}, p < 0,001 — die Ergebnisse sind seriell abhängig")
ax.set_xlabel("Lag (Positionen)")
ax.set_ylabel("Autokorrelation")
ax.legend(fontsize=9)
save(fig, "autocorrelation.png")

# ---------------------------------------------------------------------------
# 5) Fee waterfall
# ---------------------------------------------------------------------------
gross = recon["realizedPnl"]
comm = recon["commission"]
fund = recon["fundingFee"]
ins = recon["insurance"]
net = recon["netTradingPnL"]
labels = ["Brutto-\nHandelsergebnis", "Kommissionen", "Funding-\nGebühren",
          "Insurance\nClear", "Netto-\nErgebnis"]
vals = [gross, comm, fund, ins, net]
fig, ax = plt.subplots(figsize=(9, 5))
cum = 0
for i, (lab, v) in enumerate(zip(labels, vals)):
    if i == 0 or i == len(vals) - 1:
        ax.bar(i, v, color=(C_WIN if v >= 0 else C_LOSS), edgecolor="black", linewidth=0.5)
        ax.text(i, v + (1500 if v >= 0 else -3500), eur(v), ha="center", fontsize=9, fontweight="bold")
    else:
        ax.bar(i, v, bottom=cum, color=C_LOSS, edgecolor="black", linewidth=0.5)
        ax.text(i, cum + v - 2500, eur(v), ha="center", fontsize=9, fontweight="bold")
    cum = v if (i == 0) else (cum + v if i < len(vals) - 1 else cum)
ax.axhline(0, color="black", lw=0.8)
ax.set_xticks(range(len(labels)))
ax.set_xticklabels(labels, fontsize=9)
ax.set_ylabel("USD")
ax.set_title("Von der Gewinnschwelle in den Totalverlust: die Gebührenlast\n"
             f"Gebühren ({eur(comm+fund+ins)}) = {recon['feeToGrossRatio']:.0f}× des Bruttoergebnisses")
save(fig, "fee_waterfall.png")

# ---------------------------------------------------------------------------
# 6) Gross vs net
# ---------------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(6.5, 4.8))
bars = ax.bar(["Brutto-Handels-\nergebnis", "Gebühren\n(gesamt)", "Netto-\nErgebnis"],
              [gross, comm + fund + ins, net],
              color=[C_WIN, C_LOSS, C_LOSS], edgecolor="black", linewidth=0.5)
for b, v in zip(bars, [gross, comm + fund + ins, net]):
    ax.text(b.get_x() + b.get_width() / 2, v + (1500 if v >= 0 else -4000), eur(v),
            ha="center", fontweight="bold", fontsize=10)
ax.axhline(0, color="black", lw=0.8)
ax.set_ylabel("USD")
ax.set_title("Bruttoergebnis vs. Gebühren vs. Nettoergebnis")
save(fig, "fees_vs_result.png")

# ---------------------------------------------------------------------------
# 7) Equity curve + drawdown
# ---------------------------------------------------------------------------
cum_pnl = np.cumsum(pnl)
peak = np.maximum.accumulate(cum_pnl)
dd = cum_pnl - peak
xs = np.arange(N)
fig, (a1, a2) = plt.subplots(2, 1, figsize=(9, 6), sharex=True,
                             gridspec_kw={"height_ratios": [3, 1]})
a1.plot(xs, cum_pnl, color=C_LOSS, lw=1.3)
a1.fill_between(xs, cum_pnl, 0, where=(cum_pnl < 0), color=C_LOSS, alpha=0.12)
a1.axhline(0, color="black", lw=0.7)
a1.set_ylabel("Kumuliertes Ergebnis (USD)")
a1.set_title("Equity-Kurve der geschlossenen Trades (inkl. Handelskommission)\n"
             "Hinweis: ohne Funding/Insurance — diese verschlechtern das Ergebnis zusätzlich")
a2.fill_between(xs, dd, 0, color=C_NEUT, alpha=0.6)
a2.set_ylabel("Drawdown (USD)")
a2.set_xlabel("Geschlossene Trades (chronologisch)")
save(fig, "equity_curve.png")

# ---------------------------------------------------------------------------
# 8) Yearly breakdown
# ---------------------------------------------------------------------------
years = sorted(D["byYear"].keys())
y_pnl = [D["byYear"][y]["realPnLClosing"] for y in years]
y_wr = [D["byYear"][y]["winRate"] * 100 for y in years]
fig, ax = plt.subplots(figsize=(8.5, 4.8))
ax.bar(years, y_pnl, color=[C_WIN if v >= 0 else C_LOSS for v in y_pnl],
       edgecolor="black", linewidth=0.4)
ax.axhline(0, color="black", lw=0.8)
ax.set_ylabel("Realisiertes Ergebnis pro Jahr (USD, inkl. Komm.)")
ax2 = ax.twinx()
ax2.plot(years, y_wr, color=C_ACC, marker="o", lw=2, label="Trefferquote")
ax2.axhline(breakeven_wr * 100, color=C_NEUT, ls=":", lw=1.3, label=f"Gewinnschwelle {breakeven_wr*100:.1f}%")
ax2.set_ylabel("Trefferquote (%)", color=C_ACC)
ax2.set_ylim(0, 60)
ax2.grid(False)
ax2.legend(fontsize=8, loc="upper right")
ax.set_title("Jährliches Handelsergebnis und Trefferquote")
save(fig, "yearly_breakdown.png")

# ---------------------------------------------------------------------------
# 9) Per-trade P&L distribution (appendix: fat tails)
# ---------------------------------------------------------------------------
clip = np.percentile(np.abs(pnl), 99)
clipped = np.clip(pnl, -clip, clip)
fig, ax = plt.subplots(figsize=(9, 4.8))
ax.hist(clipped, bins=120, color=C_NEUT, alpha=0.8)
ax.axvline(0, color=C_LOSS, lw=1.5, ls="--")
ax.set_yscale("log")
ax.set_title(f"Verteilung der Trade-Ergebnisse (auf ±1.–99. Perzentil begrenzt)\n"
             f"Exzess-Kurtosis = {D['distribution']['kurtosisExcess']:.1f}, "
             f"Schiefe = {D['distribution']['skewness']:.2f}")
ax.set_xlabel("Ergebnis pro Trade (USD)")
ax.set_ylabel("Häufigkeit (log)")
save(fig, "pnl_histogram.png")

# ---------------------------------------------------------------------------
# 10) Execution profile: order-type mix and fill status
# ---------------------------------------------------------------------------
exec_ = D["execution"]
ts = exec_["typeStatus"]
types_order = [t for t in ["MARKET", "STOP_MARKET", "LIMIT", "STOP"] if t in exec_["typeCounts"]]
statuses = ["FILLED", "CANCELED", "EXPIRED", "NEW"]
status_color = {"FILLED": C_WIN, "CANCELED": "#7f8c8d", "EXPIRED": "#bdc3c7", "NEW": "#34495e"}
mat = {t: {s: 0 for s in statuses} for t in types_order}
for k, v in ts.items():
    t, s = [x.strip() for x in k.split("/")]
    if t in mat and s in mat[t]:
        mat[t][s] = v
fig, ax = plt.subplots(figsize=(8.5, 4.8))
xs = np.arange(len(types_order))
bottom = np.zeros(len(types_order))
for s in statuses:
    vals = np.array([mat[t][s] for t in types_order], dtype=float)
    if vals.sum() == 0:
        continue
    ax.bar(xs, vals, bottom=bottom, label=s, color=status_color[s], edgecolor="white", linewidth=0.4)
    bottom += vals
ax.set_xticks(xs)
ax.set_xticklabels([t.replace("_", "\n") for t in types_order])
ax.set_ylabel("Anzahl Orders")
ax.set_title("Order-Typen und Ausführungsstatus\n"
             f"Stop-Orders ausgelöst: {exec_['stop']['filled']} von {exec_['stop']['total']:,} "
             f"({exec_['stop']['triggerRate']*100:.2f} %)")
ax.legend(title="Status", fontsize=9)
save(fig, "order_type_status.png")

# ---------------------------------------------------------------------------
# 11) Maker vs taker commission
# ---------------------------------------------------------------------------
mt = exec_["makerTaker"]
fig, ax = plt.subplots(figsize=(6.5, 4.6))
vals = [abs(mt["takerFee"]), abs(mt["makerFee"])]
bars = ax.bar(["Taker\n(Market-Orders)", "Maker\n(Limit-Orders)"], vals,
              color=[C_LOSS, C_WIN], edgecolor="black", linewidth=0.5)
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width() / 2, v, eur(v), ha="center", va="bottom", fontweight="bold")
ax.set_ylabel("Kommission (USD)")
ax.set_title(f"{mt['takerFeeShare']*100:.1f} % der Kommissionen entfielen auf die teureren\n"
             f"Taker-Gebühren ({mt['takerFills']:,} Taker- vs. {mt['makerFills']} Maker-Ausführungen)")
save(fig, "maker_taker_fees.png")

# ---------------------------------------------------------------------------
# 12) How closing positions were exited (by order type)
# ---------------------------------------------------------------------------
ets = exec_["exitTypes"]
eorder = sorted(ets.keys(), key=lambda t: -ets[t]["n"])
fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4.4))
counts = [ets[t]["n"] for t in eorder]
a1.bar(eorder, counts, color=C_ACC, edgecolor="black", linewidth=0.4)
for i, t in enumerate(eorder):
    a1.text(i, ets[t]["n"], f"{ets[t]['n']:,}\n{ets[t]['winRate']*100:.1f}% WR",
            ha="center", va="bottom", fontsize=9)
a1.set_ylabel("Anzahl geschlossener Orders")
a1.set_title("Ausstieg nach Order-Typ (Anzahl)")
a1.margins(y=0.18)
sums = [ets[t]["sumPnL"] for t in eorder]
bars = a2.bar(eorder, sums, color=[C_WIN if v >= 0 else C_LOSS for v in sums], edgecolor="black", linewidth=0.4)
for b, v in zip(bars, sums):
    a2.text(b.get_x() + b.get_width() / 2, v, eur(v), ha="center",
            va="bottom" if v >= 0 else "top", fontweight="bold", fontsize=9)
a2.axhline(0, color="black", lw=0.8)
a2.set_ylabel("Summiertes Ergebnis (USD)")
a2.set_title("Ergebnis nach Ausstiegs-Typ")
fig.suptitle("Die Positionen wurden überwiegend manuell per Market-Order geschlossen — nicht per Stop", fontsize=11)
save(fig, "exit_type.png")

# ---------------------------------------------------------------------------
# 13) Forced liquidations by year
# ---------------------------------------------------------------------------
liq = D["liquidations"]
lyears = sorted(liq["byYear"].keys())
lcount = [liq["byYear"][y]["count"] for y in lyears]
lcost = [abs(liq["byYear"][y]["total"]) for y in lyears]
fig, ax = plt.subplots(figsize=(8.5, 4.6))
bars = ax.bar(lyears, lcount, color=C_LOSS, edgecolor="black", linewidth=0.4)
for b, c in zip(bars, lcount):
    ax.text(b.get_x() + b.get_width() / 2, c, str(c), ha="center", va="bottom", fontweight="bold")
ax.set_ylabel("Anzahl Zwangsliquidationen", color=C_LOSS)
ax2 = ax.twinx()
ax2.plot(lyears, lcost, color=C_NEUT, marker="o", lw=2, label="Liquidationskosten (USD)")
ax2.set_ylabel("Liquidationskosten (USD)")
ax2.grid(False)
ax.set_title(f"Zwangsliquidationen: {liq['count']} Ereignisse, {eur(liq['total'])} gesamt\n"
             "(Insurance-Clear-Abgaben — Indikator für überhöhten Hebel)")
save(fig, "liquidations_by_year.png")

print("\nAll charts rendered to docs/stats/img/")
