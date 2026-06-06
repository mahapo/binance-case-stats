#!/bin/bash
# Whale simulation: $100M start, VIP9, top USDⓈ-M perps over the volatile month
# October 2025 (the $19B Oct-10 liquidation crash). One coin at a time, delete the
# CSV after each run to stay within disk; cap ticks at 60M for memory safety (the
# first 60M ticks of October still include the Oct-10 crash, since files are
# chronological ascending).
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/whale-oct2025.log
CAP=60000000
# Alts/smaller files first, majors (largest files) last.
COINS="AVAXUSDT LINKUSDT SUIUSDT ADAUSDT LTCUSDT DOGEUSDT BCHUSDT XRPUSDT BNBUSDT SOLUSDT ETHUSDT BTCUSDT"

echo "WHALE BATCH START $(date)" > "$LOG"
for c in $COINS; do
  FREE=$(df -g . | tail -1 | awk '{print $4}')
  echo "" >> "$LOG"
  echo "===== $c  ($(date))  free ${FREE}Gi =====" >> "$LOG"
  if [ "$FREE" -lt 4 ]; then
    echo "SKIP $c — only ${FREE}Gi free" >> "$LOG"
    continue
  fi
  npx ts-node src/backtest.ts "$c" 2025-10 "$CAP" >> "$LOG" 2>&1
  # Free disk: drop this coin's month data (summary.json stays under output/).
  rm -f "data/aggTrades/${c}-aggTrades-2025-10.csv" \
        "data/aggTrades/${c}-aggTrades-2025-10.zip" \
        "data/aggTrades/${c}-aggTrades-2025-10.zip.part"
  echo "----- $c done; freed disk -----" >> "$LOG"
done
echo "" >> "$LOG"
echo "WHALE BATCH DONE $(date)" >> "$LOG"
