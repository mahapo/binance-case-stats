#!/bin/bash
# Realistic whale: $100M start, VIP9, top-15 USDT perps over JANUARY 2026 (Jan-29
# crash month). USDT markets (deepest liquidity). One coin at a time, delete CSV
# after (disk), 60M tick cap (memory).
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/whale-jan2026-usdt.log
CAP=60000000
# Top-15 by volume; alts/smaller first, majors last.
COINS="SUIUSDT AVAXUSDT LINKUSDT ADAUSDT DOGEUSDT LTCUSDT BCHUSDT NEARUSDT DOTUSDT TRXUSDT XRPUSDT BNBUSDT SOLUSDT ETHUSDT BTCUSDT"

echo "WHALE JAN-2026 USDT BATCH START (\$100M, VIP9) $(date)" > "$LOG"
for c in $COINS; do
  FREE=$(df -g . | tail -1 | awk '{print $4}')
  echo "" >> "$LOG"; echo "===== $c ($(date)) free ${FREE}Gi =====" >> "$LOG"
  if [ "$FREE" -lt 4 ]; then echo "SKIP $c — low disk" >> "$LOG"; continue; fi
  npx ts-node src/backtest.ts "$c" 2026-01 "$CAP" >> "$LOG" 2>&1
  rm -f "data/aggTrades/${c}-aggTrades-2026-01.csv" \
        "data/aggTrades/${c}-aggTrades-2026-01.zip" \
        "data/aggTrades/${c}-aggTrades-2026-01.zip.part"
  if ls -d output/${c}-2026-01-01_* >/dev/null 2>&1; then echo "----- $c OK -----" >> "$LOG"; else echo "----- $c no data/no trades -----" >> "$LOG"; fi
done
echo "" >> "$LOG"
echo "WHALE JAN-2026 USDT BATCH DONE $(date)" >> "$LOG"
