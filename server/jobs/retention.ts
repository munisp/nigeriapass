/**
 * Data Retention Job (P1-20, NDPR)
 * =================================
 * Purges time-limited personal data per the retention policy:
 *  - otp_codes        — expired codes older than 24 h
 *  - ussd_sessions    — ended/inactive sessions older than 30 days
 *  - qr_scan_logs     — scan logs older than 90 days
 *  - sessions         — expired JWT session rows older than 30 days
 *
 * Financial ledger rows (wallet_transactions) are NEVER purged here.
 */
import { lt } from "drizzle-orm";
import { getDb } from "../db";
import { otpCodes, ussdSessions, qrScanLogs, sessions } from "../../drizzle/schema";

export interface RetentionResult {
  otpCodesPurged: number;
  ussdSessionsPurged: number;
  qrScanLogsPurged: number;
  sessionsPurged: number;
}

export const RETENTION_POLICY = {
  otpCodesHours: 24,
  ussdSessionsDays: 30,
  qrScanLogsDays: 90,
  expiredSessionsDays: 30,
} as const;

export async function runRetentionPurge(): Promise<RetentionResult> {
  const db = await getDb();
  if (!db) {
    console.warn("[Retention] Database unavailable — skipping purge");
    return { otpCodesPurged: 0, ussdSessionsPurged: 0, qrScanLogsPurged: 0, sessionsPurged: 0 };
  }

  const result: RetentionResult = {
    otpCodesPurged: 0,
    ussdSessionsPurged: 0,
    qrScanLogsPurged: 0,
    sessionsPurged: 0,
  };

  const otpCutoff = new Date(Date.now() - RETENTION_POLICY.otpCodesHours * 3600_000);
  const ussdCutoff = new Date(Date.now() - RETENTION_POLICY.ussdSessionsDays * 86_400_000);
  const qrCutoff = new Date(Date.now() - RETENTION_POLICY.qrScanLogsDays * 86_400_000);
  const sessionCutoff = new Date(Date.now() - RETENTION_POLICY.expiredSessionsDays * 86_400_000);

  try {
    const r = await db.delete(otpCodes).where(lt(otpCodes.expiresAt, otpCutoff)).returning({ id: otpCodes.id });
    result.otpCodesPurged = r.length;
  } catch (err) { console.error("[Retention] otp_codes purge failed:", err); }

  try {
    const r = await db.delete(ussdSessions)
      .where(lt(ussdSessions.lastActivityAt, ussdCutoff))
      .returning({ id: ussdSessions.id });
    result.ussdSessionsPurged = r.length;
  } catch (err) { console.error("[Retention] ussd_sessions purge failed:", err); }

  try {
    const r = await db.delete(qrScanLogs).where(lt(qrScanLogs.scannedAt, qrCutoff)).returning({ id: qrScanLogs.id });
    result.qrScanLogsPurged = r.length;
  } catch (err) { console.error("[Retention] qr_scan_logs purge failed:", err); }

  try {
    const r = await db.delete(sessions).where(lt(sessions.expiresAt, sessionCutoff)).returning({ id: sessions.id });
    result.sessionsPurged = r.length;
  } catch (err) { console.error("[Retention] sessions purge failed:", err); }

  console.log(
    `[Retention] Purged otp=${result.otpCodesPurged} ussd=${result.ussdSessionsPurged} ` +
    `qr=${result.qrScanLogsPurged} sessions=${result.sessionsPurged}`
  );
  return result;
}
