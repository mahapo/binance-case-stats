#!/bin/bash
# The REST of the USDC perps (everything not in the top-14 batch) over JANUARY 2026,
# $10k start, VIP9 — so together we have ALL 38 USDC markets for Jan 2026. Waits for
# the first USDC batch to finish (no RAM contention). Skips coins without Jan data.
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/usdc-jan2026-rest.log
CAP=60000000
# DeFi/large alts first, high-volume memes later.
COINS="AAVEUSDC UNIUSDC CRVUSDC ENAUSDC ETHFIUSDC FILUSDC HBARUSDC NEOUSDC ORDIUSDC \
TIAUSDC WLDUSDC ZECUSDC TRUMPUSDC KAITOUSDC BIOUSDC IPUSDC WLFIUSDC PENGUUSDC PNUTUSDC \
BOMEUSDC WIFUSDC 1000SHIBUSDC 1000BONKUSDC 1000PEPEUSDC"

# Wait for the top-14 USDC batch to finish first.
until grep -q "USDC JAN-2026 BATCH DONE" output/usdc-jan2026.log 2>/dev/null; do sleep 20; done

echo "USDC JAN-2026 REST BATCH START $(date)" > "$LOG"
for c in $COINS; do
  FREE=$(df -g . | tail -1 | awk '{print $4}')
  echo "" >> "$LOG"; echo "===== $c ($(date)) free ${FREE}Gi =====" >> "$LOG"
  if [ "$FREE" -lt 4 ]; then echo "SKIP $c — low disk" >> "$LOG"; continue; fi
  npx ts-node src/backtest.ts "$c" 2026-01 "$CAP" >> "$LOG" 2>&1
  rm -f "data/aggTrades/${c}-aggTrades-2026-01.csv" \
        "data/aggTrades/${c}-aggTrades-2026-01.zip" \
        "data/aggTrades/${c}-aggTrades-2026-01.zip.part"
  if ls -d output/${c}-2026-01-01_* >/dev/null 2>&1; then
    echo "----- $c OK -----" >> "$LOG"
  else
    echo "----- $c no data / no trades -----" >> "$LOG"
  fi
done
echo "" >> "$LOG"
echo "USDC JAN-2026 REST BATCH DONE $(date)" >> "$LOG"
