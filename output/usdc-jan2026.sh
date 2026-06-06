#!/bin/bash
# Retail USDC batch: $10,000 start, VIP9, top USDⓈ-M *USDC* perps over JANUARY 2026
# (the Jan-29 crash month). USDC quote → 0% maker / lowest taker; at $10k the
# position brackets don't bind, so this shows the real volatility % upside.
# One coin at a time, delete CSV after (disk), 60M tick cap (memory).
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/usdc-jan2026.log
CAP=60000000
# Alts/smaller files first, majors (largest) last.
COINS="SUIUSDC AVAXUSDC LINKUSDC ADAUSDC DOGEUSDC LTCUSDC BCHUSDC NEARUSDC ARBUSDC XRPUSDC BNBUSDC SOLUSDC ETHUSDC BTCUSDC"

echo "USDC JAN-2026 BATCH START (start \$10k, VIP9) $(date)" > "$LOG"
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
echo "USDC JAN-2026 BATCH DONE $(date)" >> "$LOG"
