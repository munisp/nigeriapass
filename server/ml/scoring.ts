/**
 * Typed client for the Python ML scoring server (ml/serving/score_server.py).
 *
 * When ML_SCORING_URL is unset or the server is unreachable/times out, every
 * function falls back to a deterministic pure-TS heuristic over the SAME
 * feature schema as the trained models, and reports `source: "fallback"`.
 * The heuristic is a stop-gap, not a model: it exists so the PWA degrades
 * gracefully instead of failing open with random scores (audit finding).
 */
import type { CreditFeatures, FraudFeatures } from "./features";

export interface FraudScore {
  fraud_probability: number;
  decision: "allow" | "review" | "block";
  model_version?: string;
  source: "model" | "fallback";
}

export interface CreditScore {
  p_default: number;
  credit_limit_naira: number;
  model_version?: string;
  source: "model" | "fallback";
}

const TIMEOUT_MS = 800;
const TIER_CAPS: Record<number, number> = { 1: 5_000, 2: 50_000, 3: 250_000 };

function scoringUrl(): string | null {
  return process.env.ML_SCORING_URL ?? null;
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const base = scoringUrl();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // network error / abort -> fallback
  } finally {
    clearTimeout(timer);
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Heuristic fraud score over the model feature schema (fallback only). */
function heuristicFraud(f: FraudFeatures): number {
  const logit =
    -3.2 +
    0.45 * Math.min(f.tx_count_1h, 15) / 3 +
    0.2 * Math.min(f.tx_count_24h, 40) / 8 +
    0.35 * Math.max(-3, Math.min(3, f.amount_z)) +
    0.5 * Math.log1p(Math.max(f.device_degree - 1, 0)) +
    0.3 * Math.log1p(Math.max(f.ip_degree - 1, 0)) +
    0.4 * f.is_night * f.is_transfer -
    0.15 * Math.min(f.days_since_signup, 90) / 30 -
    0.2 * (f.kyc_tier - 1);
  return sigmoid(logit);
}

/** Heuristic default-probability over the credit feature schema. */
function heuristicCredit(f: CreditFeatures): number {
  const logit =
    -1.0 -
    0.3 * Math.log1p(f.account_age_days) -
    0.25 * Math.log1p(f.tx_count_30d) -
    0.2 * f.avg_topup_amount_log +
    0.8 * f.has_chargeback -
    0.3 * (f.kyc_tier - 1) -
    0.01 * f.kyc_score / 10;
  return sigmoid(logit);
}

export async function scoreFraud(f: FraudFeatures): Promise<FraudScore> {
  const res = await post<{
    fraud_probability: number;
    decision: FraudScore["decision"];
    version?: { version: string };
  }>("/score/fraud", { features: f });
  if (res && typeof res.fraud_probability === "number") {
    return {
      fraud_probability: res.fraud_probability,
      decision: res.decision,
      model_version: res.version?.version,
      source: "model",
    };
  }
  const p = heuristicFraud(f);
  return {
    fraud_probability: p,
    decision: p >= 0.8 ? "block" : p >= 0.5 ? "review" : "allow",
    source: "fallback",
  };
}

export async function scoreCredit(f: CreditFeatures): Promise<CreditScore> {
  const res = await post<{
    p_default: number;
    credit_limit_naira: number;
    version?: { version: string };
  }>("/score/credit", { features: f });
  if (res && typeof res.p_default === "number") {
    return {
      p_default: res.p_default,
      credit_limit_naira: res.credit_limit_naira,
      model_version: res.version?.version,
      source: "model",
    };
  }
  const p = heuristicCredit(f);
  const cap = TIER_CAPS[Math.round(f.kyc_tier)] ?? TIER_CAPS[1];
  return {
    p_default: p,
    credit_limit_naira: Math.round(cap * Math.max(0, 1 - p) * 100) / 100,
    source: "fallback",
  };
}

export interface GnnScore {
  fraud_probability: number;
  model_version?: string;
  source: "model" | "fallback";
}

/** GNN scoring has no meaningful local heuristic; conservative 0.5 prior. */
export async function scoreGnn(payload: {
  x: number[][];
  edge_src: number[];
  edge_dst: number[];
  node_index: number;
}): Promise<GnnScore> {
  const res = await post<{
    fraud_probability: number;
    version?: { version: string };
  }>("/score/gnn", payload);
  if (res && typeof res.fraud_probability === "number") {
    return {
      fraud_probability: res.fraud_probability,
      model_version: res.version?.version,
      source: "model",
    };
  }
  return { fraud_probability: 0.5, source: "fallback" };
}
