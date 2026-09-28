/**
 * Unified Payment Reference Helper
 * =================================
 * Single source of truth for NigerianPass payment reference format:
 *
 *   NP-<PROVIDER>-<userId>-<timestampMs>[-<rand>]
 *
 * Examples:
 *   NP-PAYSTACK-42-1700000000000
 *   NP-FLUTTERWAVE-7-1700000000123-KX9F2A
 *
 * ALL code paths (tRPC initiateTopup, provider webhooks, verifyTopup,
 * reconciliation job) MUST generate and parse references through these
 * helpers. Legacy formats (nigerianpass_<userId>_<ts>, NP-TOPUP-<userId>-<ts>)
 * are recognised by parsePaymentReference for backward compatibility with
 * in-flight transactions but must never be generated.
 */

import type { PaymentProviderSlug } from "./gateway";

const PROVIDER_TOKENS: Record<PaymentProviderSlug, string> = {
  paystack: "PAYSTACK",
  flutterwave: "FLUTTERWAVE",
  interswitch: "INTERSWITCH",
};

const TOKEN_TO_SLUG: Record<string, PaymentProviderSlug> = {
  PAYSTACK: "paystack",
  FLUTTERWAVE: "flutterwave",
  INTERSWITCH: "interswitch",
};

export interface ParsedPaymentReference {
  provider: PaymentProviderSlug;
  userId: number;
  timestamp: number;
  /** True when parsed from a legacy format (nigerianpass_* or NP-TOPUP-*) */
  legacy: boolean;
}

/** Build a canonical payment reference. */
export function buildPaymentReference(
  provider: PaymentProviderSlug,
  userId: number,
  timestamp: number = Date.now(),
): string {
  const token = PROVIDER_TOKENS[provider];
  if (!token) throw new Error(`Unknown payment provider: ${provider}`);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`Invalid userId for payment reference: ${userId}`);
  }
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `NP-${token}-${userId}-${timestamp}-${rand}`;
}

/**
 * Parse a payment reference. Returns null for unrecognised formats.
 * Accepts canonical NP-<PROVIDER>-<userId>-<ts>[-rand] plus legacy formats.
 */
export function parsePaymentReference(ref: string): ParsedPaymentReference | null {
  if (!ref || typeof ref !== "string") return null;

  // Canonical: NP-<PROVIDER>-<userId>-<ts>[-rand]
  const canonical = ref.match(/^NP-(PAYSTACK|FLUTTERWAVE|INTERSWITCH)-(\d+)-(\d{10,})(?:-[A-Z0-9]+)?$/i);
  if (canonical) {
    const provider = TOKEN_TO_SLUG[canonical[1]!.toUpperCase()]!;
    return {
      provider,
      userId: parseInt(canonical[2]!, 10),
      timestamp: parseInt(canonical[3]!, 10),
      legacy: false,
    };
  }

  // Legacy tRPC: NP-TOPUP-<userId>-<ts>
  const legacyTopup = ref.match(/^NP-TOPUP-(\d+)-(\d{10,})$/);
  if (legacyTopup) {
    return {
      provider: "paystack", // legacy default provider
      userId: parseInt(legacyTopup[1]!, 10),
      timestamp: parseInt(legacyTopup[2]!, 10),
      legacy: true,
    };
  }

  // Legacy REST: nigerianpass_<userId>_<ts>
  const legacyRest = ref.match(/^nigerianpass_(\d+)_(\d{10,})$/);
  if (legacyRest) {
    return {
      provider: "paystack",
      userId: parseInt(legacyRest[1]!, 10),
      timestamp: parseInt(legacyRest[2]!, 10),
      legacy: true,
    };
  }

  return null;
}

/** Extract the userId from a payment reference, or null if unparseable. */
export function userIdFromReference(ref: string): number | null {
  return parsePaymentReference(ref)?.userId ?? null;
}

/** Extract the provider slug from a payment reference, or null. */
export function providerFromReference(ref: string): PaymentProviderSlug | null {
  return parsePaymentReference(ref)?.provider ?? null;
}
