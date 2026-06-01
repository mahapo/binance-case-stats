#!/usr/bin/env python3
"""
Binance Futures USD-M — Statistical Disadvantage Analysis (charts + advanced stats)

Reads docs/stats/new/analysis_data.json (produced by futures_analysis_v2.js) and:
  * bootstrap 95% CI for the mean per-trade P&L (robust to non-normality)
  * Wilson 95% CI for the win rate
  * Monte-Carlo distribution of the maximum loss streak under the trader's OWN
    loss rate -> empirical p-value for the observed streak (the honest baseline)
  * Wald-Wolfowitz runs test for independence/clustering of the win/loss sequence
  * an illustrative "fair coin" (50%) comparison for the appendix

Writes all PNG charts to docs/stats/new/img/ and the computed statistics to
docs/stats/new/computed_values.json so the report can cite exact numbers.

Run:  source .venv/bin/activate && python scripts/generate_charts.py
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "stats", "new")
IMG = os.path.join(OUT, "img")
os.makedirs(IMG, exist_ok=True)

RNG = np.random.default_rng(20260601)  # fixed seed -> reproducible figures
N_BOOT = 50_000
N_SIM = 200_000

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


def eur(x):  # USD formatting helper for labels
    return f"${x:,.0f}"


def save(fig, name):
    path = os.path.join(IMG, name)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    print("  wrote img/" + name)


# ---------------------------------------------------------------------------
with open(os.path.join(OUT, "analysis_data.json"), encoding="utf-8") as f:
    D = json.load(f)

recon = D["reconciliation"]
overall = D["overall"]
seq = D["sequences"]
pnl = np.array(seq["closingPnLChrono"], dtype=float)
wl = np.array(seq["winLossSeq"], dtype=int)  # 1 win, 0 loss
N = len(pnl)
n_wins = int(overall["nWins"])
n_losses = int(overall["nLosses"])
loss_rate = overall["lossRate"]
win_rate = overall["winRate"]
obs_max_loss_streak = int(overall["maxLossStreak"])

print(f"Loaded {N} closing trades  |  win rate {win_rate*100:.2f}%  |  obs max loss streak {obs_max_loss_streak}")

results = {}

# ---------------------------------------------------------------------------
# 1) Bootstrap CI for mean per-trade P&L
# ---------------------------------------------------------------------------
boot_means = pnl[RNG.integers(0, N, size=(N_BOOT, N))].mean(axis=1)
ci_lo, ci_hi = np.percentile(boot_means, [2.5, 97.5])
mean_pnl = float(pnl.mean())
# classic one-sample t-test against 0 (reference)
t_stat, t_p = stats.ttest_1samp(pnl, 0.0)
results["expected_value"] = {
    "mean_pnl_per_trade": mean_pnl,
    "bootstrap_ci95": [float(ci_lo), float(ci_hi)],
    "bootstrap_p_mean_ge_0": float(np.mean(boot_means >= 0)),
    "ttest_t": float(t_stat),
    "ttest_p_two_sided": float(t_p),
    "n_trades": N,
}

fig, ax = plt.subplots(figsize=(8, 4.5))
ax.hist(boot_means, bins=80, color=C_ACC, alpha=0.75, edgecolor="white", linewidth=0.3)
# normal overlay
x = np.linspace(boot_means.min(), boot_means.max(), 400)
ax.plot(x, stats.norm.pdf(x, boot_means.mean(), boot_means.std()) * N_BOOT *
        (boot_means.max() - boot_means.min()) / 80, color=C_NEUT, lw=1.5,
        label="Normalverteilungs-Näherung")
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
# 2) Wilson CI for win rate
# ---------------------------------------------------------------------------
z = 1.959963985
p = win_rate
denom = 1 + z**2 / N
centre = (p + z**2 / (2 * N)) / denom
half = (z * np.sqrt(p * (1 - p) / N + z**2 / (4 * N**2))) / denom
w_lo, w_hi = centre - half, centre + half
# R:R-implied breakeven win rate (used for the appendix discussion)
rr = overall["rrRatio"]
breakeven_wr = 1 / (1 + rr) if rr > 0 else float("nan")
results["win_rate"] = {
    "win_rate": win_rate,
    "wilson_ci95": [float(w_lo), float(w_hi)],
    "n_trades": N, "n_wins": n_wins, "n_losses": n_losses,
    "rr_ratio": rr,
    "breakeven_win_rate_implied": float(breakeven_wr),
}

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
# 3) Monte-Carlo: max loss streak under the trader's OWN loss rate
# ---------------------------------------------------------------------------
def simulate_max_loss_streaks(n_sims, n_trials, p_loss, chunk=10_000):
    """Max run of losses per simulated sequence, computed in memory-safe chunks."""
    out = np.empty(n_sims, dtype=np.int32)
    done = 0
    while done < n_sims:
        m = min(chunk, n_sims - done)
        losses = (RNG.random((m, n_trials)) < p_loss)
        run = np.zeros(m, dtype=np.int32)
        best = np.zeros(m, dtype=np.int32)
        for j in range(n_trials):
            run = (run + 1) * losses[:, j]
            np.maximum(best, run, out=best)
        out[done:done + m] = best
        done += m
    return out

# PRIMARY baseline (per court framing): a FAIR market consistent with the realized
# reward/risk ratio — i.e. the R:R-implied break-even win rate. loss prob = rr/(1+rr).
loss_rate_fair = 1.0 - breakeven_wr
mc_fair = simulate_max_loss_streaks(N_SIM, N, loss_rate_fair)
p_fair = float(np.mean(mc_fair >= obs_max_loss_streak))
# SECONDARY (robustness): the trader's own realized loss rate.
mc_own = simulate_max_loss_streaks(N_SIM, N, loss_rate)
p_own = float(np.mean(mc_own >= obs_max_loss_streak))
results["max_loss_streak"] = {
    "observed": obs_max_loss_streak,
    "unit": "economic position",
    "n_sims": N_SIM,
    "primary_fair_rr_baseline": {
        "rr_ratio": rr, "breakeven_win_rate": breakeven_wr, "sim_loss_rate": loss_rate_fair,
        "p_value_ge_observed": p_fair,
        "median_max_streak": float(np.median(mc_fair)),
        "p95_max_streak": float(np.percentile(mc_fair, 95)),
        "p99_max_streak": float(np.percentile(mc_fair, 99)),
    },
    "secondary_own_rate_baseline": {
        "loss_rate": loss_rate, "p_value_ge_observed": p_own,
        "median_max_streak": float(np.median(mc_own)),
    },
}

fig, ax = plt.subplots(figsize=(8, 4.5))
bins = np.arange(mc_fair.min(), max(obs_max_loss_streak, mc_fair.max()) + 2) - 0.5
ax.hist(mc_fair, bins=bins, color=C_ACC, alpha=0.8, edgecolor="white", linewidth=0.3,
        label=f"Simulierte längste Verlustserie\n(faire Gewinnschwelle {breakeven_wr*100:.1f}% bei CRV 1:{rr:.2f}, {N_SIM:,} Sim.)")
ax.axvline(obs_max_loss_streak, color=C_LOSS, lw=2.5,
           label=f"Beobachtet: {obs_max_loss_streak} Verluste in Folge")
ax.axvline(np.median(mc_fair), color=C_NEUT, lw=1.5, ls="--",
           label=f"Median Simulation: {np.median(mc_fair):.0f}")
ax.set_title("Längste Verlustserie — Monte-Carlo unter einem fairen Markt (CRV-Gewinnschwelle)\n"
             f"p(≥{obs_max_loss_streak}) = {p_fair:.3f}  (Einheit: wirtschaftliche Position, n={N:,})")
ax.set_xlabel("Längste Verlustserie in einer simulierten Handelshistorie")
ax.set_ylabel("Anzahl Simulationen")
ax.legend(fontsize=9)
save(fig, "maxstreak_montecarlo.png")

# ---------------------------------------------------------------------------
# 4) Wald-Wolfowitz runs test (independence / clustering)
# ---------------------------------------------------------------------------
runs = 1 + int(np.sum(wl[1:] != wl[:-1]))
n1, n2 = n_wins, n_losses
mu = 2 * n1 * n2 / N + 1
var = 2 * n1 * n2 * (2 * n1 * n2 - N) / (N**2 * (N - 1))
z_runs = (runs - mu) / np.sqrt(var)
p_runs = 2 * stats.norm.sf(abs(z_runs))
results["runs_test"] = {
    "observed_runs": runs,
    "expected_runs": float(mu),
    "z": float(z_runs),
    "p_two_sided": float(p_runs),
    "interpretation": ("fewer runs than expected -> clustering"
                       if z_runs < 0 else "more runs than expected -> alternation")
                      + ("  (NOT significant)" if p_runs >= 0.05 else "  (significant)"),
}

# ---------------------------------------------------------------------------
# 5) Observed vs expected loss-streak frequency (own rate + fair coin)
# ---------------------------------------------------------------------------
hist = {int(k): int(v) for k, v in seq["lossStreakHistogram"].items()}
kmax = max(hist) if hist else 1
ks = np.arange(1, kmax + 1)
observed = np.array([hist.get(int(k), 0) for k in ks], dtype=float)

def expected_run_counts(n, p_event, lengths):
    """Expected number of maximal runs of exactly length k (iid Bernoulli)."""
    q = 1 - p_event
    out = []
    for k in lengths:
        if k < n:
            out.append((n - k - 1) * q * q * p_event**k + 2 * q * p_event**k)
        else:
            out.append(p_event**n)
    return np.array(out)

exp_fair = expected_run_counts(N, loss_rate_fair, ks)   # fair market (R:R break-even)
exp_own = expected_run_counts(N, loss_rate, ks)         # robustness: own loss rate
results["loss_streak_frequency"] = {
    "lengths": ks.tolist(),
    "observed": observed.tolist(),
    "expected_fair_rr": exp_fair.tolist(),
    "expected_own_rate": exp_own.tolist(),
}

fig, ax = plt.subplots(figsize=(9, 4.8))
wbar = 0.4
ax.bar(ks - wbar / 2, observed, width=wbar, color=C_LOSS, label="Beobachtet (Positionen)")
ax.bar(ks + wbar / 2, exp_fair, width=wbar, color=C_ACC,
       label=f"Erwartet bei fairem Markt (Gewinnschwelle {breakeven_wr*100:.1f}%, CRV 1:{rr:.2f})")
ax.set_yscale("symlog", linthresh=1)
ax.set_title("Verlustserien: beobachtete vs. bei fairem Markt erwartete Häufigkeit\n"
             "(Baseline = CRV-Gewinnschwelle — fairer, belastbarer Referenzprozess)")
ax.set_xlabel("Länge der Verlustserie (aufeinanderfolgende Verluste, Positionsebene)")
ax.set_ylabel("Anzahl (symlog)")
ax.legend(fontsize=9)
save(fig, "streak_freq_observed_vs_expected.png")

# ---------------------------------------------------------------------------
# 6) Fee waterfall
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
ax.set_title(f"Von der Gewinnschwelle in den Totalverlust: die Gebührenlast\n"
             f"Gebühren ({eur(comm+fund+ins)}) = {recon['feeToGrossRatio']:.0f}× des Bruttoergebnisses")
save(fig, "fee_waterfall.png")

# ---------------------------------------------------------------------------
# 7) Gross vs net (simple, high-impact)
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
# 8) Equity curve + drawdown
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
# 9) Yearly breakdown
# ---------------------------------------------------------------------------
years = sorted(D["byYear"].keys())
y_pnl = [D["byYear"][y]["realPnLClosing"] for y in years]
y_wr = [D["byYear"][y]["winRate"] * 100 for y in years]
fig, ax = plt.subplots(figsize=(8.5, 4.8))
bars = ax.bar(years, y_pnl, color=[C_WIN if v >= 0 else C_LOSS for v in y_pnl],
              edgecolor="black", linewidth=0.4)
ax.axhline(0, color="black", lw=0.8)
ax.set_ylabel("Realisiertes Ergebnis pro Jahr (USD, inkl. Komm.)")
ax2 = ax.twinx()
ax2.plot(years, y_wr, color=C_ACC, marker="o", lw=2, label="Trefferquote")
ax2.set_ylabel("Trefferquote (%)", color=C_ACC)
ax2.set_ylim(0, 60)
ax2.grid(False)
ax.set_title("Jährliches Handelsergebnis und Trefferquote")
save(fig, "yearly_breakdown.png")

# ---------------------------------------------------------------------------
# 10) Per-trade P&L distribution (appendix: fat tails / kurtosis)
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
# 11) Execution profile: order-type mix and fill status
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
# 12) Maker vs taker commission
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
# 13) How closing positions were exited (by order type)
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
fig.suptitle("94 % der Positionen wurden manuell per Market-Order geschlossen — nicht per Stop", fontsize=11)
save(fig, "exit_type.png")

# ---------------------------------------------------------------------------
# 14) Forced liquidations by year
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

# ---------------------------------------------------------------------------
results["execution_summary"] = {
    "type_counts": exec_["typeCounts"],
    "stop_trigger_rate": exec_["stop"]["triggerRate"],
    "taker_fill_share": mt["takerFillShare"],
    "taker_fee_share": mt["takerFeeShare"],
    "commission_bps": D["commissionBps"],
    "exit_types": {t: {"n": ets[t]["n"], "winRate": ets[t]["winRate"], "sumPnL": ets[t]["sumPnL"]} for t in ets},
    "liquidations": {"count": liq["count"], "total": liq["total"]},
}
results["meta"] = {
    "n_bootstrap": N_BOOT, "n_simulations": N_SIM, "seed": 20260601,
    "fee_to_gross_ratio": recon["feeToGrossRatio"],
    "cost_bps_of_notional": D["costBps"],
    "net_trading_pnl": net, "binance_reported_net": recon["reportedNet"],
    "reconciliation_delta": recon["reconciliationDelta"],
}
with open(os.path.join(OUT, "computed_values.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

print("\nKey advanced statistics:")
print(f"  Mean P&L/trade: {mean_pnl:.4f}  bootstrap 95% CI [{ci_lo:.4f}, {ci_hi:.4f}]")
print(f"  t-test vs 0: t={t_stat:.3f}, p={t_p:.3e}")
print(f"  Win rate Wilson 95% CI: [{w_lo*100:.2f}%, {w_hi*100:.2f}%]  (breakeven {breakeven_wr*100:.2f}%)")
print(f"  Max loss streak {obs_max_loss_streak} (positions): p(fair R:R)={p_fair:.4f}  p(own rate)={p_own:.4f}")
print(f"  Runs test: runs={runs}, expected={mu:.1f}, z={z_runs:.3f}, p={p_runs:.3f}")
print("Wrote computed_values.json")
