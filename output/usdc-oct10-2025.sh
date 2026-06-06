#!/bin/bash
# Most-volatile-DAY comparison: ALL USDC perps on 2025-10-10 (the $19B liquidation
# crash — the single most volatile day) at $10k / VIP9 / USDC, to compare against
# the calm-month January 2026 run (section 5.3). Daily files → small & fast.
cd /Users/manuel/Documents/Programmierung/Projekte/binance-case-stats || exit 1
export NODE_OPTIONS=--max-old-space-size=10240
LOG=output/usdc-oct10-2025.log
CAP=60000000
# All 38 USDC perps (alts/memes first, majors last). Coins not yet listed on
# 2025-10-10 simply 404 and are skipped.
COINS="AAVEUSDC UNIUSDC CRVUSDC ENAUSDC ETHFIUSDC FILUSDC HBARUSDC NEOUSDC ORDIUSDC \
TIAUSDC WLDUSDC ZECUSDC TRUMPUSDC KAITOUSDC BIOUSDC IPUSDC WLFIUSDC PENGUUSDC PNUTUSDC \
BOMEUSDC WIFUSDC 1000SHIBUSDC 1000BONKUSDC 1000PEPEUSDC NEARUSDC ARBUSDC LINKUSDC SUIUSDC \
AVAXUSDC LTCUSDC BCHUSDC ADAUSDC DOGEUSDC XRPUSDC BNBUSDC SOLUSDC ETHUSDC BTCUSDC"

echo "USDC OCT-10-2025 (most volatile day) BATCH START — \$10k, VIP9 $(date)" > "$LOG"
for c in $COINS; do
  FREE=$(df -g . | tail -1 | awk '{print $4}')
  echo "" >> "$LOG"; echo "===== $c ($(date)) free ${FREE}Gi =====" >> "$LOG"
  if [ "$FREE" -lt 4 ]; then echo "SKIP $c — low disk" >> "$LOG"; continue; fi
  npx ts-node src/backtest.ts "$c" 2025-10-10 "$CAP" >> "$LOG" 2>&1
  rm -f "data/aggTrades/${c}-aggTrades-2025-10-10.csv" \
        "data/aggTrades/${c}-aggTrades-2025-10-10.zip" \
        "data/aggTrades/${c}-aggTrades-2025-10-10.zip.part"
  if ls -d output/${c}-2025-10-10* >/dev/null 2>&1; then
    echo "----- $c OK -----" >> "$LOG"
  else
    echo "----- $c no data / no trades -----" >> "$LOG"
  fi
done
echo "" >> "$LOG"
echo "USDC OCT-10-2025 BATCH DONE $(date)" >> "$LOG"
