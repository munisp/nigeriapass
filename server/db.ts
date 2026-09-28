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
  kycStatusHistory,
  sessions,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: Pool | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
// In production this FAILS FAST (throws) instead of returning null so that
// money-moving code paths can never silently degrade.
export async function getDb() {
  if (!_db) {
    const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "";
    if (!url || (!url.startsWith("postgres") && !url.startsWith("postgresql"))) {
      const msg = "[Database] No valid PostgreSQL URL found in POSTGRES_URL or DATABASE_URL";
      if (ENV.isProduction) throw new Error(msg);
      console.warn(msg);
      return null;
    }
    try {
      // TLS: when a CA certificate is provided, verify the server identity.
      // sslmode=require without a CA uses an encrypted-but-unverified channel
      // only outside production.
      const ca = process.env.DATABASE_CA_CERT ?? process.env.PGSSLROOTCERT;
      const wantsSsl = url.includes("sslmode=require") || url.includes("ssl=true") || !!ca;
      const ssl = wantsSsl
        ? ca
          ? { rejectUnauthorized: true, ca }
          : ENV.isProduction
            ? { rejectUnauthorized: true }
            : { rejectUnauthorized: false }
        : false;

      _pool = new Pool({
        connectionString: url,
        ssl,
        max: parseInt(process.env.PG_POOL_MAX ?? "10", 10),
        idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS ?? "30000", 10),
        connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS ?? "10000", 10),
        statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS ?? "15000", 10),
        allowExitOnIdle: false,
      });
      _pool.on("error", (err) => {
        console.error("[Database] Unexpected idle-client error:", err);
      });
      _db = drizzle(_pool);
      console.log("[Database] PostgreSQL connection established");
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
      if (ENV.isProduction) throw error;
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

  // Read the current row for the status-history trail
  const [current] = await db
    .select({ status: kycApplications.status })
    .from(kycApplications)
    .where(eq(kycApplications.referenceId, referenceId))
    .limit(1);

  // Only overwrite review fields that were explicitly provided — previously
  // omitted fields were wiped to null (audit v13, P1-14).
  const set: Record<string, unknown> = {
    status,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  };
  if (opts?.reviewNotes !== undefined) set.reviewNotes = opts.reviewNotes;
  if (opts?.reviewedBy !== undefined) set.reviewedBy = opts.reviewedBy;
  if (opts?.kycScore !== undefined) set.kycScore = opts.kycScore;

  await db.update(kycApplications)
    .set(set)
    .where(eq(kycApplications.referenceId, referenceId));

  // Append immutable status history
  await db.insert(kycStatusHistory).values({
    referenceId,
    fromStatus: current?.status ?? null,
    toStatus: status,
    changedBy: opts?.reviewedBy ?? null,
    notes: opts?.reviewNotes ?? null,
  });
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

// ── Atomic Wallet Operations ──────────────────────────────────────────────────
// These helpers perform credit/debit inside a single DB transaction with an
// INSERT ... ON CONFLICT (external_ref) DO NOTHING idempotency guard and an
// atomic SQL balance update. No read-modify-write balance math in JS.

export type WalletCreditResult =
  | { status: "credited"; walletId: number; transactionId: number; newBalanceKobo: number }
  | { status: "duplicate" }
  | { status: "no_wallet" };

/** Atomically credit a user's wallet. Idempotent on externalRef. */
export async function creditWalletAtomic(params: {
  userId: number;
  amountKobo: number;
  externalRef: string;
  type: "topup" | "refund" | "adjustment";
  description: string;
}): Promise<WalletCreditResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx) => {
    const wallets = await tx
      .select({ id: walletAccounts.id })
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, params.userId))
      .limit(1);
    const wallet = wallets[0];
    if (!wallet) return { status: "no_wallet" } as const;

    // Idempotency guard — external_ref has a UNIQUE constraint; a replayed
    // webhook/retry inserts zero rows here and we bail out without crediting.
    const inserted = await tx
      .insert(walletTransactions)
      .values({
        walletId: wallet.id,
        type: params.type,
        amountKobo: params.amountKobo,
        balanceAfterKobo: 0, // patched below after the atomic increment
        externalRef: params.externalRef,
        description: params.description,
      })
      .onConflictDoNothing({ target: walletTransactions.externalRef })
      .returning({ id: walletTransactions.id });

    if (inserted.length === 0) return { status: "duplicate" } as const;

    // Atomic increment — no JS read-modify-write of the balance
    const updated = await tx
      .update(walletAccounts)
      .set({
        balanceKobo: sql`${walletAccounts.balanceKobo} + ${params.amountKobo}`,
        lastBalanceSync: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id))
      .returning({ balanceKobo: walletAccounts.balanceKobo });

    const newBalance = updated[0]?.balanceKobo ?? 0;
    await tx
      .update(walletTransactions)
      .set({ balanceAfterKobo: newBalance })
      .where(eq(walletTransactions.id, inserted[0]!.id));

    return {
      status: "credited",
      walletId: wallet.id,
      transactionId: inserted[0]!.id,
      newBalanceKobo: newBalance,
    } as const;
  });
}

export type WalletDebitResult =
  | { status: "debited"; walletId: number; transactionId: number; newBalanceKobo: number }
  | { status: "duplicate" }
  | { status: "no_wallet" }
  | { status: "insufficient_funds"; balanceKobo: number }
  | { status: "daily_cap_exceeded"; dailyCapKobo: number; dailySpentKobo: number };

/**
 * Atomically debit a user's wallet (toll charges).
 * Idempotent on externalRef; enforces balance >= 0 and the daily fare cap.
 */
export async function debitWalletAtomic(params: {
  userId: number;
  amountKobo: number;
  externalRef: string;
  description: string;
  plazaId?: string;
}): Promise<WalletDebitResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.transaction(async (tx) => {
    const wallets = await tx
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, params.userId))
      .limit(1);
    const wallet = wallets[0];
    if (!wallet) return { status: "no_wallet" } as const;

    // Daily cap enforcement (resets handled by wallet.getBalance / nightly job)
    if (wallet.dailySpentKobo + params.amountKobo > wallet.dailyCapKobo) {
      return {
        status: "daily_cap_exceeded",
        dailyCapKobo: wallet.dailyCapKobo,
        dailySpentKobo: wallet.dailySpentKobo,
      } as const;
    }

    // Idempotency guard
    const inserted = await tx
      .insert(walletTransactions)
      .values({
        walletId: wallet.id,
        type: "toll_charge",
        amountKobo: params.amountKobo,
        balanceAfterKobo: 0,
        externalRef: params.externalRef,
        plazaId: params.plazaId ?? null,
        description: params.description,
      })
      .onConflictDoNothing({ target: walletTransactions.externalRef })
      .returning({ id: walletTransactions.id });

    if (inserted.length === 0) return { status: "duplicate" } as const;

    // Conditional atomic decrement — the WHERE clause guarantees the balance
    // can never go negative even under concurrent debits.
    const updated = await tx
      .update(walletAccounts)
      .set({
        balanceKobo: sql`${walletAccounts.balanceKobo} - ${params.amountKobo}`,
        dailySpentKobo: sql`${walletAccounts.dailySpentKobo} + ${params.amountKobo}`,
        lastBalanceSync: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(walletAccounts.id, wallet.id),
        sql`${walletAccounts.balanceKobo} >= ${params.amountKobo}`,
      ))
      .returning({ balanceKobo: walletAccounts.balanceKobo });

    if (updated.length === 0) {
      // Roll back the transaction row by throwing — the caller sees
      // insufficient_funds and no ledger entry is committed.
      const err = new Error("insufficient_funds") as Error & { code?: string };
      err.code = "insufficient_funds";
      throw err;
    }

    const newBalance = updated[0]!.balanceKobo;
    await tx
      .update(walletTransactions)
      .set({ balanceAfterKobo: newBalance })
      .where(eq(walletTransactions.id, inserted[0]!.id));

    return {
      status: "debited",
      walletId: wallet.id,
      transactionId: inserted[0]!.id,
      newBalanceKobo: newBalance,
    } as const;
  }).catch((err: Error & { code?: string }) => {
    if (err.code === "insufficient_funds") {
      return { status: "insufficient_funds", balanceKobo: -1 } as const;
    }
    throw err;
  });
}

// ── Session Registry (JWT revocation) ─────────────────────────────────────────

export async function createSessionRecord(data: {
  jti: string;
  userId: number;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(sessions).values({
    jti: data.jti,
    userId: data.userId,
    expiresAt: data.expiresAt,
    ip: data.ip ?? null,
    userAgent: data.userAgent ?? null,
  }).onConflictDoNothing({ target: sessions.jti });
}

/** Returns true when the session jti exists and has been revoked. */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false; // dev without DB — nothing to check against
  const rows = await db
    .select({ revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.jti, jti))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  return row.revokedAt !== null;
}

export async function revokeSession(jti: string) {
  const db = await getDb();
  if (!db) return;
  await db.update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.jti, jti), sql`${sessions.revokedAt} IS NULL`));
}

export async function revokeAllSessionsForUser(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const updated = await db.update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} IS NULL`))
    .returning({ id: sessions.id });
  return updated.length;
}

// ── Users by phone (USSD account linking) ─────────────────────────────────────

/** Resolve a user by E.164 phone number (openId convention: "phone:<msisdn>"). */
export async function getUserByPhone(msisdn: string) {
  return getUserByOpenId(`phone:${msisdn}`);
}
