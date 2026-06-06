#!/bin/bash
# Fill-in pass: after the main whale batch finishes, run whichever of the
# internet-dropped coins still lack an Oct-2025 output folder. Waits for the main
# batch first so we never run two heavy ts-node jobs at once (16 GB RAM).
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/whale-oct2025.log
CAP=60000000

# Wait until the main batch declares done (it continues past failures).
until grep -q "WHALE BATCH DONE" "$LOG" 2>/dev/null; do sleep 20; done

echo "" >> "$LOG"
echo "===== FILL-IN PASS $(date) =====" >> "$LOG"
for c in XRPUSDT SOLUSDT ETHUSDT BTCUSDT; do
  if ls -d output/${c}-2025-10-01_* >/dev/null 2>&1; then
    echo "OK already have $c — skip" >> "$LOG"; continue
  fi
  FREE=$(df -g . | tail -1 | awk '{print $4}')
  echo "===== FILL $c ($(date)) free ${FREE}Gi =====" >> "$LOG"
  if [ "$FREE" -lt 4 ]; then echo "SKIP $c — low disk" >> "$LOG"; continue; fi
  npx ts-node src/backtest.ts "$c" 2025-10 "$CAP" >> "$LOG" 2>&1
  rm -f "data/aggTrades/${c}-aggTrades-2025-10.csv" \
        "data/aggTrades/${c}-aggTrades-2025-10.zip" \
        "data/aggTrades/${c}-aggTrades-2025-10.zip.part"
  echo "----- FILL $c done -----" >> "$LOG"
done
echo "WHALE FILL DONE $(date)" >> "$LOG"
