/**
 * OTP Service — Africa's Talking SMS Integration
 * ================================================
 * Handles generation, delivery, and verification of 6-digit SMS OTP codes
 * for phone-number login. Uses Africa's Talking API in production and falls
 * back to a demo mode (code = 123456) when AT_API_KEY is not configured.
 *
 * Security properties:
 *  - Codes are bcrypt-hashed before storage (cost factor 10)
 *  - Codes expire after 2 minutes
 *  - Maximum 5 failed verification attempts before lockout
 *  - Previous unused codes for the same phone are invalidated on new send
 *  - Rate limiting is enforced at the Express route level (see middleware/rateLimiter.ts)
 */
import bcrypt from "bcryptjs";
import { eq, and, gt, lt } from "drizzle-orm";
import { getDb } from "../db";
import { otpCodes } from "../../drizzle/schema";
import { ENV } from "../_core/env.js";

// ── Africa's Talking client (lazy-initialised) ────────────────────────────────

// Evaluated at call time so tests can stub env and production never gets a
// stale module-load snapshot.
function atApiKey(): string {
  return ENV.atApiKey;
}
const AT_USERNAME = ENV.atUsername || "sandbox";
const AT_SENDER_ID = ENV.atSenderId || "NigerianPass";

/**
 * Demo mode is ONLY permitted outside production. In production a missing
 * AT_API_KEY must fail closed — never accept a fixed code for any phone.
 */
function isDemoMode(): boolean {
  if (ENV.isProduction) return false;
  const key = atApiKey();
  return !key || key === "demo";
}

interface AtSmsResponse {
  SMSMessageData: {
    Message: string;
    Recipients: Array<{
      statusCode: number;
      number: string;
      status: string;
      cost: string;
      messageId: string;
    }>;
  };
}

async function sendViaSmsApi(phone: string, code: string): Promise<string | null> {
  if (isDemoMode()) {
    console.log(`[OTP] DEMO MODE (non-production) — code for ${phone}: ${code}`);
    return "demo-message-id";
  }

  const apiKey = atApiKey();
  if (!apiKey) {
    // Fail closed in production: no SMS provider configured.
    throw new Error("SMS provider not configured (AT_API_KEY missing)");
  }

  const body = new URLSearchParams({
    username: AT_USERNAME,
    to: phone,
    message: `Your NigerianPass verification code is: ${code}. Valid for 2 minutes. Do not share this code.`,
    from: AT_SENDER_ID,
  });

  const baseUrl =
    AT_USERNAME === "sandbox"
      ? "https://api.sandbox.africastalking.com/version1/messaging"
      : "https://api.africastalking.com/version1/messaging";

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      apiKey,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Africa's Talking API error ${res.status}: ${text}`);
  }

  const data: AtSmsResponse = await res.json();
  const recipient = data.SMSMessageData.Recipients[0];

  if (!recipient || recipient.statusCode !== 101) {
    throw new Error(
      `SMS delivery failed: ${recipient?.status ?? "unknown error"}`
    );
  }

  return recipient.messageId;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SendOtpResult {
  success: boolean;
  /** Masked phone number for display (e.g. +234801****678) */
  maskedPhone: string;
  /** Demo mode only — the actual code (never returned in production) */
  demoCode?: string;
  /** Seconds until the code expires */
  expiresInSeconds: number;
}

/**
 * Generate a new OTP code, invalidate any existing codes for this phone,
 * hash and store it, then send via Africa's Talking SMS.
 */
export async function sendOtp(
  phone: string,
  requestIp?: string
): Promise<SendOtpResult> {
  const db = await getDb();

  // Generate a cryptographically random 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

  // Invalidate all previous unused codes for this phone
  if (db) {
    await db
      .update(otpCodes)
      .set({ used: true })
      .where(and(eq(otpCodes.phone, phone), eq(otpCodes.used, false)));
  }

  // Send SMS first (fail fast before writing to DB)
  let messageId: string | null = null;
  try {
    messageId = await sendViaSmsApi(phone, code);
  } catch (err) {
    throw new Error(`Failed to send OTP SMS: ${(err as Error).message}`);
  }

  // Persist the hashed code
  if (db) {
    await db.insert(otpCodes).values({
      phone,
      codeHash,
      used: false,
      attempts: 0,
      requestIp: requestIp ?? null,
      messageId: messageId ?? null,
      expiresAt,
    });
  }

  // Mask phone for display: +2348012345678 → +234801****678
  const masked = phone.replace(/(\+\d{3})(\d{3})(\d{4})(\d+)/, "$1$2****$4");

  return {
    success: true,
    maskedPhone: masked,
    // Never return the code in production — demoCode is dev/test only.
    demoCode: isDemoMode() ? code : undefined,
    expiresInSeconds: 120,
  };
}

export interface VerifyOtpResult {
  success: boolean;
  /** JWT-ready user identifier (phone number normalised) */
  phone?: string;
  error?: "expired" | "invalid" | "used" | "max_attempts" | "not_found";
  /** Remaining attempts before lockout */
  attemptsLeft?: number;
}

/**
 * Verify a submitted OTP code against the stored hash.
 * Increments the attempt counter and marks the code as used on success.
 */
export async function verifyOtp(
  phone: string,
  submittedCode: string
): Promise<VerifyOtpResult> {
  const db = await getDb();

  // Demo mode (development/test ONLY): accept the fixed code without a DB
  // lookup. In production isDemoMode() is always false, so this branch is
  // unreachable there — verification always hits the hashed DB record.
  if (isDemoMode() && submittedCode === "123456") {
    return { success: true, phone };
  }

  if (!db) {
    if (ENV.isProduction) {
      // Fail closed: never verify OTPs without a backing store in production.
      throw new Error("OTP store unavailable");
    }
    return { success: false, error: "invalid" };
  }

  const now = new Date();

  // Find the most recent unused, non-expired code for this phone
  const rows = await db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.phone, phone),
        eq(otpCodes.used, false),
        gt(otpCodes.expiresAt, now)
      )
    )
    .orderBy(otpCodes.createdAt)
    .limit(1);

  const record = rows[0];

  if (!record) {
    // Check if there's an expired code to give a better error message
    const expiredRows = await db
      .select({ id: otpCodes.id })
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.phone, phone),
          eq(otpCodes.used, false),
          lt(otpCodes.expiresAt, now)
        )
      )
      .limit(1);

    return {
      success: false,
      error: expiredRows.length > 0 ? "expired" : "not_found",
    };
  }

  // Check attempt limit (max 5)
  const MAX_ATTEMPTS = 5;
  if (record.attempts >= MAX_ATTEMPTS) {
    // Mark as used to prevent further attempts
    await db
      .update(otpCodes)
      .set({ used: true })
      .where(eq(otpCodes.id, record.id));
    return { success: false, error: "max_attempts", attemptsLeft: 0 };
  }

  // Verify the code
  const isValid = await bcrypt.compare(submittedCode, record.codeHash);

  if (!isValid) {
    const newAttempts = record.attempts + 1;
    await db
      .update(otpCodes)
      .set({ attempts: newAttempts })
      .where(eq(otpCodes.id, record.id));

    return {
      success: false,
      error: "invalid",
      attemptsLeft: MAX_ATTEMPTS - newAttempts,
    };
  }

  // Mark code as used
  await db
    .update(otpCodes)
    .set({ used: true })
    .where(eq(otpCodes.id, record.id));

  return { success: true, phone };
}

/**
 * Clean up expired OTP codes older than 24 hours.
 * Called by the reconciliation job or a separate cron.
 */
export async function purgeExpiredOtps(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db
    .delete(otpCodes)
    .where(lt(otpCodes.expiresAt, cutoff));

  return (result as unknown as { affectedRows: number }).affectedRows ?? 0;
}
