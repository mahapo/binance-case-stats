import { Transaction } from "./load";
import { BINANCE_REPORTED_NET } from "./paths";

// Trading-relevant flows (everything that hits the wallet because of trading).
// TRANSFER (deposits/withdrawals) and COIN_SWAP_* (balance conversions) are NOT
// trading results and are excluded from the net trading P&L.
const PNL_COMPONENTS = ["REALIZED_PNL", "COMMISSION", "FUNDING_FEE", "INSURANCE_CLEAR"];

export interface Reconciliation {
  byType: Record<string, { count: number; total: number }>;
  byAsset: Record<string, number>;
  commissionByAsset: Record<string, number>;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  insurance: number;
  totalFees: number;
  netTradingPnL: number;
  feeToGrossRatio: number | null;
  reportedNet: number;
  reconciliationDelta: number;
}

export function reconcile(transactions: Transaction[]): Reconciliation {
  const byType: Record<string, { count: number; total: number }> = {};
  for (const tx of transactions) {
    if (!byType[tx.type]) byType[tx.type] = { count: 0, total: 0 };
    byType[tx.type].count++;
    byType[tx.type].total += tx.amount;
  }
  const get = (t: string): number => (byType[t] ? byType[t].total : 0);

  // The ledger is multi-asset (USDT, BUSD ~1:1 USD, plus a tiny amount of BNB-paid
  // commission). We sum face amounts; BUSD is a 1:1 USD stablecoin (valid as USD),
  // while BNB commissions are at face BNB value — their USD market value explains the
  // small residual versus Binance's USD "Lifetime PNL".
  const byAsset: Record<string, number> = {};
  const commissionByAsset: Record<string, number> = {};
  for (const tx of transactions) {
    if (!PNL_COMPONENTS.includes(tx.type)) continue;
    const a = tx.asset || "UNKNOWN";
    byAsset[a] = (byAsset[a] || 0) + tx.amount;
    if (tx.type === "COMMISSION") {
      commissionByAsset[a] = (commissionByAsset[a] || 0) + tx.amount;
    }
  }

  const realizedPnl = get("REALIZED_PNL");
  const commission = get("COMMISSION");
  const fundingFee = get("FUNDING_FEE");
  const insurance = get("INSURANCE_CLEAR");
  const totalFees = commission + fundingFee + insurance; // all negative
  const netTradingPnL = realizedPnl + totalFees;

  return {
    byType,
    byAsset,
    commissionByAsset,
    realizedPnl,
    commission,
    fundingFee,
    insurance,
    totalFees,
    netTradingPnL,
    // How fees devour the gross result: |fees| / |gross realized|.
    feeToGrossRatio: realizedPnl !== 0 ? Math.abs(totalFees) / Math.abs(realizedPnl) : null,
    reportedNet: BINANCE_REPORTED_NET,
    reconciliationDelta: netTradingPnL - BINANCE_REPORTED_NET,
  };
}
