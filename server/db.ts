import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  InsertKycApplication,
  InsertOtpCode,
  InsertSyncQueueItem,
  InsertWalletAccount,
  InsertWalletTransaction,
  InsertUser,
  InsertReconciliationRun,
  InsertNfcBatchJob,
  NfcBatchJob,
  kycApplications,
  otpCodes,
  syncQueue,
  users,
  walletAccounts,
  walletTransactions,
  reconciliationRuns,
  nfcBatchJobs,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: Pool | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db) {
    const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "";
    if (!url || (!url.startsWith("postgres") && !url.startsWith("postgresql"))) {
      console.warn("[Database] No valid PostgreSQL URL found in POSTGRES_URL or DATABASE_URL");
      return null;
    }
    try {
      _pool = new Pool({ connectionString: url, ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : false });
      _db = drizzle(_pool);
      console.log("[Database] PostgreSQL connection established");
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

    // PostgreSQL: INSERT ... ON CONFLICT DO UPDATE
    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet as Partial<InsertUser>,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot get user: database not available"); return undefined; }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ── KYC Applications ──────────────────────────────────────────────────────────

/** Generate a human-readable reference ID like DRV-XKQP7 */
export function generateReferenceId(type: "driver" | "vehicle" | "fleet"): string {
  const prefix = { driver: "DRV", vehicle: "VEH", fleet: "FLT" }[type];
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${suffix}`;
}

export async function createKycApplication(data: InsertKycApplication) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(kycApplications).values(data).returning();
  return result[0];
}

export async function getKycApplicationsByUserId(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(kycApplications)
    .where(eq(kycApplications.userId, userId))
    .orderBy(desc(kycApplications.createdAt));
}

export async function getKycApplicationByReferenceId(referenceId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(kycApplications)
    .where(eq(kycApplications.referenceId, referenceId)).limit(1);
  return result[0];
}

export async function updateKycApplicationStatus(
  referenceId: string,
  status: KycApplication["status"],
  opts?: { reviewNotes?: string; reviewedBy?: number; kycScore?: number }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(kycApplications)
    .set({
      status,
      reviewNotes: opts?.reviewNotes ?? null,
      reviewedBy: opts?.reviewedBy ?? null,
      kycScore: opts?.kycScore ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(kycApplications.referenceId, referenceId));
}

type KycApplication = typeof kycApplications.$inferSelect;

// ── Wallet Accounts ───────────────────────────────────────────────────────────

export async function getOrCreateWalletAccount(userId: number): Promise<typeof walletAccounts.$inferSelect> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db.select().from(walletAccounts)
    .where(eq(walletAccounts.userId, userId)).limit(1);
  if (existing[0]) return existing[0];

  const tbId = `TB${userId.toString().padStart(10, "0")}${Date.now().toString(36).toUpperCase()}`;
  const newWallet: InsertWalletAccount = {
    userId,
    tigerBeetleId: tbId,
    balanceKobo: 0,
    dailyCapKobo: 500000,
    dailySpentKobo: 0,
    lastBalanceSync: new Date(),
  };
  const created = await db.insert(walletAccounts).values(newWallet).returning();
  return created[0]!;
}

export async function getWalletTransactions(walletId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(walletTransactions)
    .where(eq(walletTransactions.walletId, walletId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(limit);
}

export async function recordWalletTransaction(data: InsertWalletTransaction) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(walletTransactions).values(data).returning();
  await db.update(walletAccounts)
    .set({ balanceKobo: data.balanceAfterKobo, lastBalanceSync: new Date(), updatedAt: new Date() })
    .where(eq(walletAccounts.id, data.walletId));
  return result[0]!;
}

// ── Sync Queue ────────────────────────────────────────────────────────────────

export async function upsertSyncQueueItem(item: InsertSyncQueueItem) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // PostgreSQL: INSERT ... ON CONFLICT DO UPDATE (idempotent on clientId)
  const result = await db.insert(syncQueue).values(item).onConflictDoUpdate({
    target: syncQueue.clientId,
    set: {
      status: "pending",
      attempts: item.attempts ?? 0,
      updatedAt: new Date(),
    },
  }).returning();
  return result[0]!;
}

export async function markSyncQueueItemDone(clientId: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(syncQueue)
    .set({ status: "done", processedAt: new Date(), updatedAt: new Date() })
    .where(eq(syncQueue.clientId, clientId));
}

export async function markSyncQueueItemFailed(clientId: string, error: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(syncQueue)
    .set({
      status: "failed",
      lastError: error,
      attempts: sql`${syncQueue.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(syncQueue.clientId, clientId));
}

export async function getPendingSyncItems(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(syncQueue)
    .where(and(eq(syncQueue.userId, userId), inArray(syncQueue.status, ["pending", "failed"])))
    .orderBy(syncQueue.queuedAt)
    .limit(100);
}

// ── OTP Codes ─────────────────────────────────────────────────────────────────

export async function createOtpCode(data: InsertOtpCode) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Invalidate any existing unused codes for this phone
  await db.update(otpCodes)
    .set({ used: true })
    .where(and(eq(otpCodes.phone, data.phone), eq(otpCodes.used, false)));
  const result = await db.insert(otpCodes).values(data).returning();
  return result[0]!;
}

export async function getLatestOtpCode(phone: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.used, false)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  return result[0];
}

export async function markOtpCodeUsed(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, id));
}

export async function incrementOtpAttempts(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(eq(otpCodes.id, id));
}

export async function cleanupExpiredOtpCodes() {
  const db = await getDb();
  if (!db) return;
  await db.delete(otpCodes).where(lt(otpCodes.expiresAt, new Date()));
}

// ── Wallet Pending-Match Transactions ─────────────────────────────────────────

/** Get all wallet transactions with no external reference (pending match) */
export async function getPendingMatchTransactions() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(walletTransactions)
    .where(and(
      eq(walletTransactions.type, "topup"),
      sql`${walletTransactions.externalRef} IS NULL`,
    ))
    .orderBy(walletTransactions.createdAt)
    .limit(200);
}

/** Link a wallet transaction to an external payment reference */
export async function linkTransactionToExternalRef(id: number, externalRef: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(walletTransactions)
    .set({ externalRef })
    .where(eq(walletTransactions.id, id));
}

/** Get wallet account by TigerBeetle ID */
export async function getWalletByTigerBeetleId(tbId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(walletAccounts)
    .where(eq(walletAccounts.tigerBeetleId, tbId)).limit(1);
  return result[0];
}

/** Get wallet account by user ID */
export async function getWalletByUserId(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(walletAccounts)
    .where(eq(walletAccounts.userId, userId)).limit(1);
  return result[0];
}

// ── Reconciliation Runs ────────────────────────────────────────────────────────────

/** Persist a completed reconciliation run to the DB */
export async function createReconciliationRun(data: InsertReconciliationRun) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(reconciliationRuns).values(data).returning();
  return result[0];
}

/** Get the most recent N reconciliation runs */
export async function getReconciliationRuns(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reconciliationRuns)
    .orderBy(desc(reconciliationRuns.startedAt))
    .limit(limit);
}

/** Mark a reconciliation run as resolved by an admin */
export async function resolveReconciliationRun(
  id: number,
  resolvedNote?: string
) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .update(reconciliationRuns)
    .set({ resolvedAt: new Date(), resolvedNote: resolvedNote ?? null })
    .where(eq(reconciliationRuns.id, id))
    .returning();
  return result[0];
}

// ── NFC Batch Provisioning Helpers ────────────────────────────────────────────


/** Create a new NFC batch provisioning job record */
export async function createNfcBatchJob(data: InsertNfcBatchJob): Promise<NfcBatchJob | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(nfcBatchJobs).values(data).returning();
  return result[0];
}

/** Update an NFC batch job with progress/completion data */
export async function updateNfcBatchJob(
  jobRef: string,
  updates: Partial<Pick<NfcBatchJob, "status" | "provisioned" | "failed" | "results" | "errorMessage" | "durationMs" | "completedAt">>
): Promise<NfcBatchJob | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .update(nfcBatchJobs)
    .set(updates)
    .where(eq(nfcBatchJobs.jobRef, jobRef))
    .returning();
  return result[0];
}

/** Get a single NFC batch job by reference */
export async function getNfcBatchJob(jobRef: string): Promise<NfcBatchJob | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(nfcBatchJobs)
    .where(eq(nfcBatchJobs.jobRef, jobRef))
    .limit(1);
  return rows[0];
}

/** List NFC batch jobs for an admin (most recent first) */
export async function listNfcBatchJobs(limit = 20): Promise<NfcBatchJob[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(nfcBatchJobs)
    .orderBy(desc(nfcBatchJobs.createdAt))
    .limit(limit);
}
