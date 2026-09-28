/**
 * Feature extraction from drizzle rows for the ML scoring bridge.
 *
 * The feature schemas below MUST stay in sync with:
 *   - ml/synthetic/features.py  (FRAUD_FEATURES / CREDIT_FEATURES)
 *   - the scaler buffers baked into ml/artifacts/<model>/<version>/model.pt
 *
 * All monetary values are converted kobo -> naira before scoring.
 */
import type { KycApplication, User, WalletTransaction } from "../../drizzle/schema";

/** Canonical fraud feature vector (14 dims), mirrors FRAUD_FEATURES. */
export interface FraudFeatures {
  amount_log: number;
  amount_z: number;
  tx_count_1h: number;
  tx_count_24h: number;
  device_degree: number;
  ip_degree: number;
  kyc_age_days: number;
  kyc_tier: number;
  hour_sin: number;
  hour_cos: number;
  is_night: number;
  days_since_signup: number;
  is_transfer: number;
  is_topup: number;
}

/** Canonical credit feature vector (10 dims), mirrors CREDIT_FEATURES. */
export interface CreditFeatures {
  account_age_days: number;
  tx_count_30d: number;
  topup_count_30d: number;
  avg_topup_amount_log: number;
  toll_spend_30d_log: number;
  avg_balance_proxy_log: number;
  balance_volatility: number;
  kyc_tier: number;
  kyc_score: number;
  has_chargeback: number;
}

const DAY_MS = 86_400_000;

function toMs(ts: Date | string | number | null | undefined): number {
  if (ts == null) return 0;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  return new Date(ts).getTime();
}

export interface FraudFeatureContext {
  /** Trailing tx counts for this user (1h / 24h windows) from storage. */
  txCount1h: number;
  txCount24h: number;
  /** Number of distinct users seen on this device / IP. */
  deviceDegree: number;
  ipDegree: number;
  /** Per-user amount stats for the z-score. */
  userAmountMean: number;
  userAmountStd: number;
  /** KYC tier 1..3 (default 1 when unknown). */
  kycTier?: number;
}

/**
 * Build the fraud feature vector for one candidate transaction.
 */
export function extractFraudFeatures(
  tx: Pick<WalletTransaction, "type" | "amountKobo" | "createdAt">,
  user: Pick<User, "createdAt">,
  kyc: Pick<KycApplication, "createdAt"> | null,
  ctx: FraudFeatureContext,
  now: number = Date.now(),
): FraudFeatures {
  const amountNaira = Math.max(tx.amountKobo / 100, 0);
  const txMs = toMs(tx.createdAt) || now;
  const hour = new Date(txMs).getUTCHours() + 1; // WAT = UTC+1
  const std = Math.max(ctx.userAmountStd, 1);
  const signupMs = toMs(user.createdAt);
  const kycMs = kyc ? toMs(kyc.createdAt) : txMs;
  return {
    amount_log: Math.log1p(amountNaira),
    amount_z: Math.max(-8, Math.min(8, (amountNaira - ctx.userAmountMean) / std)),
    tx_count_1h: ctx.txCount1h,
    tx_count_24h: ctx.txCount24h,
    device_degree: ctx.deviceDegree,
    ip_degree: ctx.ipDegree,
    kyc_age_days: Math.max(0, (txMs - kycMs) / DAY_MS),
    kyc_tier: ctx.kycTier ?? 1,
    hour_sin: Math.sin((2 * Math.PI * (hour % 24)) / 24),
    hour_cos: Math.cos((2 * Math.PI * (hour % 24)) / 24),
    is_night: hour % 24 < 6 || hour % 24 >= 23 ? 1 : 0,
    days_since_signup: Math.max(0, (txMs - signupMs) / DAY_MS),
    // schema enum is ("topup","toll_charge","refund","adjustment"); P2P
    // transfers are recorded as adjustments with a transfer description.
    is_transfer: (tx.type as string) === "transfer" ? 1 : 0,
    is_topup: tx.type === "topup" ? 1 : 0,
  };
}

export interface CreditFeatureContext {
  txCount30d: number;
  topupCount30d: number;
  avgTopupAmountNaira: number;
  tollSpend30dNaira: number;
  /** Mean of per-tx amount z-scores (balance proxy). */
  avgBalanceProxy: number;
  balanceVolatility: number;
  hasChargeback: boolean;
  kycTier?: number;
}

/**
 * Build the credit feature vector for one user (fleet credit-limit scoring).
 */
export function extractCreditFeatures(
  user: Pick<User, "createdAt">,
  kyc: Pick<KycApplication, "kycScore"> | null,
  ctx: CreditFeatureContext,
  now: number = Date.now(),
): CreditFeatures {
  return {
    account_age_days: Math.max(1, (now - toMs(user.createdAt)) / DAY_MS),
    tx_count_30d: ctx.txCount30d,
    topup_count_30d: ctx.topupCount30d,
    avg_topup_amount_log: Math.log1p(Math.max(ctx.avgTopupAmountNaira, 0)),
    toll_spend_30d_log: Math.log1p(Math.max(ctx.tollSpend30dNaira, 0)),
    avg_balance_proxy_log: Math.log1p(Math.max(ctx.avgBalanceProxy, 0)),
    balance_volatility: ctx.balanceVolatility,
    kyc_tier: ctx.kycTier ?? 1,
    kyc_score: kyc?.kycScore ?? 0,
    has_chargeback: ctx.hasChargeback ? 1 : 0,
  };
}
