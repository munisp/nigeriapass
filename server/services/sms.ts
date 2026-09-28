/**
 * SMS Notification Service
 * ========================
 * Sends transactional SMS messages via Africa's Talking API.
 * Falls back to demo mode (console log) when AT_API_KEY is not configured.
 *
 * Used by:
 *  - KYC approve/reject mutations (admin router)
 *  - Wallet credit notifications (reconciliation job)
 *  - OTP delivery (otp.ts — uses its own inline implementation)
 */

import { ENV } from "../_core/env.js";

const AT_API_KEY = ENV.atApiKey;
const AT_USERNAME = ENV.atUsername || "sandbox";
const AT_SENDER_ID = ENV.atSenderId || "NigerianPass";
const DEMO_MODE = !AT_API_KEY || AT_API_KEY === "demo";

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

/**
 * Send a plain-text SMS to a Nigerian phone number.
 * Returns the Africa's Talking messageId on success, or null in demo mode.
 * Throws on API errors.
 */
export async function sendSms(phone: string, message: string): Promise<string | null> {
  if (DEMO_MODE) {
    console.log(`[SMS] DEMO MODE — to ${phone}: ${message}`);
    return null;
  }

  const body = new URLSearchParams({
    username: AT_USERNAME,
    to: phone,
    message,
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
      apiKey: AT_API_KEY,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Africa's Talking SMS error ${res.status}: ${text}`);
  }

  const data: AtSmsResponse = await res.json();
  const recipient = data.SMSMessageData.Recipients[0];

  if (!recipient || recipient.statusCode !== 101) {
    throw new Error(`SMS delivery failed: ${recipient?.status ?? "unknown error"}`);
  }

  return recipient.messageId;
}

// ── Pre-built message templates ───────────────────────────────────────────────

export function kycApprovedMessage(referenceId: string, applicantName?: string): string {
  const name = applicantName ? `, ${applicantName}` : "";
  return (
    `Congratulations${name}! Your NigerianPass application (${referenceId}) has been APPROVED. ` +
    `You can now access all NigerianPass services. Visit https://nigerianpass.ng for details.`
  );
}

export function kycRejectedMessage(referenceId: string, reason: string, applicantName?: string): string {
  const name = applicantName ? `, ${applicantName}` : "";
  return (
    `Hello${name}, your NigerianPass application (${referenceId}) was NOT approved. ` +
    `Reason: ${reason.slice(0, 100)}. Please visit https://nigerianpass.ng to resubmit.`
  );
}

export function kycResubmissionMessage(referenceId: string, notes: string, applicantName?: string): string {
  const name = applicantName ? `, ${applicantName}` : "";
  return (
    `Hello${name}, your NigerianPass application (${referenceId}) requires updates. ` +
    `${notes.slice(0, 100)}. Please log in to resubmit: https://nigerianpass.ng`
  );
}

export function walletCreditedMessage(amount: number, newBalance: number, applicantName?: string): string {
  const name = applicantName ? `, ${applicantName}` : "";
  const fmt = (n: number) => (n / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 });
  return (
    `Hello${name}! Your NigerianPass wallet has been credited with ₦${fmt(amount)}. ` +
    `New balance: ₦${fmt(newBalance)}. Thank you for using NigerianPass.`
  );
}

export function tierUpgradeMessage(newTier: string, applicantName?: string): string {
  const name = applicantName ? `, ${applicantName}` : "";
  return (
    `Congratulations${name}! Your NigerianPass wallet has been upgraded to the ${newTier} tier. ` +
    `You now enjoy higher transaction limits and exclusive benefits. Visit https://nigerianpass.ng`
  );
}
