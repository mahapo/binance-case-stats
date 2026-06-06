#!/bin/bash
# Low-cap volatility batch: $100M whale on small-cap, high-volatility USDⓈ-M perps
# over FEBRUARY 2026 (the Q1-2026 altcoin crash month). Demonstrates the bracket
# ceiling: on low-caps a whale physically cannot deploy size. Waits for the Oct
# whale batch to finish first (16 GB RAM — never two heavy jobs at once). Tries a
# generous candidate list and skips coins without Feb-2026 data; stops at 15 hits.
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/lowcap-feb2026.log
CAP=60000000
WANT=15

# Wait for the October batch + its fill pass to fully finish.
until grep -q "WHALE FILL DONE" output/whale-oct2025.log 2>/dev/null; do sleep 20; done

echo "LOWCAP FEB-2026 BATCH START $(date)" > "$LOG"
# Volatile small-cap candidates (older, reliably-listed first). Misses are skipped.
COINS="NKNUSDT NULSUSDT BAKEUSDT ALPACAUSDT CHESSUSDT FLMUSDT ATAUSDT PHBUSDT \
MBOXUSDT CELRUSDT REEFUSDT LINAUSDT STMXUSDT GHSTUSDT COMBOUSDT PERPUSDT AMBUSDT \
BNXUSDT VIDTUSDT DEGENUSDT ZKJUSDT UXLINKUSDT SLERFUSDT NEIROETHUSDT"

hits=0
for c in $COINS; do
  [ "$hits" -ge "$WANT" ] && break
  if ls -d output/${c}-2026-02* >/dev/null 2>&1; then
    echo "OK already have $c" >> "$LOG"; hits=$((hits+1)); continue
  fi
  FREE=$(df -g . | tail -1 | awk '{print $4}')
  echo "" >> "$LOG"; echo "===== $c ($(date)) free ${FREE}Gi  hits=$hits =====" >> "$LOG"
  [ "$FREE" -lt 4 ] && { echo "SKIP $c low disk" >> "$LOG"; continue; }
  npx ts-node src/backtest.ts "$c" 2026-02 "$CAP" >> "$LOG" 2>&1
  rm -f "data/aggTrades/${c}-aggTrades-2026-02.csv" \
        "data/aggTrades/${c}-aggTrades-2026-02.zip" \
        "data/aggTrades/${c}-aggTrades-2026-02.zip.part"
  if ls -d output/${c}-2026-02* >/dev/null 2>&1; then
    hits=$((hits+1)); echo "----- $c OK (hits=$hits) -----" >> "$LOG"
  else
    echo "----- $c no data / no trades -----" >> "$LOG"
  fi
done
echo "" >> "$LOG"
echo "LOWCAP FEB-2026 BATCH DONE — $hits coins $(date)" >> "$LOG"
