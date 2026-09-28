/**
 * NigerianPass Payment Reconciliation Job
 * =========================================
 * Runs nightly (default: 02:00 WAT) to:
 *  1. Find wallet transactions with status = "pending_match" (webhook arrived
 *     before the user's wallet account was created, or reference lookup failed).
 *  2. For each unmatched transaction, query the payment provider's verify API
 *     to confirm the transaction is genuinely successful.
 *  3. Match the transaction to a wallet account by email or reference prefix.
 *  4. Credit the wallet and update the transaction status to "completed".
 *  5. Emit a WebSocket event so the user's wallet page updates live.
 *  6. Log a summary and notify the owner on completion.
 *
 * Scheduling:
 *  - Called from server/_core/index.ts on startup (schedules the interval).
 *  - Can also be triggered manually via POST /api/trpc/admin.runReconciliation.
 *
 * Architecture:
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  reconcile()                                                     │
 *  │    → getDb() → query wallet_transactions WHERE status=pending    │
 *  │    → for each: getProvider(provider).verifyTransaction(ref, key) │
 *  │    → if verified: creditWallet + updateStatus + emitWsEvent      │
 *  │    → summary log + notifyOwner                                   │
 *  └──────────────────────────────────────────────────────────────────┘
 */

import { eq, and, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { walletAccounts, walletTransactions, users } from "../../drizzle/schema";
import { getProvider, getProviderSecretKey, PaymentProviderSlug } from "../payments/gateway";
import { parsePaymentReference } from "../payments/reference";
import { getKycStatusEmitter } from "../events/kycEvents";
import { notifyOwner } from "../_core/notification";
import { createReconciliationRun } from "../db";
import { tierUpgradeMessage, walletCreditedMessage, sendSms } from "../services/sms";

// ── Tier helpers ──────────────────────────────────────────────────────────────

function getWalletTier(balanceKobo: number): "basic" | "standard" | "premium" {
  if (balanceKobo >= 5_000_000) return "premium";
  if (balanceKobo >= 1_000_000) return "standard";
  return "basic";
}

const TIER_RANK: Record<"basic" | "standard" | "premium", number> = {
  basic: 0, standard: 1, premium: 2,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReconciliationResult {
  processed: number;
  credited: number;
  failed: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

// ── Core reconciliation logic ─────────────────────────────────────────────────

export async function reconcile(): Promise<ReconciliationResult> {
  const startTime = Date.now();
  const result: ReconciliationResult = {
    processed: 0,
    credited: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
  };

  console.log("[Reconcile] Starting payment reconciliation job...");

  const db = await getDb();
  if (!db) {
    const msg = "Database not available — skipping reconciliation";
    console.warn(`[Reconcile] ${msg}`);
    result.errors.push(msg);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── 1. Find all pending transactions older than 5 minutes ─────────────────
  // (Give webhooks a grace period before treating them as unmatched)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  let pendingTransactions: Array<{
    id: number;
    walletId: number;
    externalRef: string | null;
    amountKobo: number;
    description: string | null;
    createdAt: Date;
  }>;

  try {
    // We use a custom status field stored in description as a workaround
    // since the schema doesn't have a status column on wallet_transactions.
    // Pending transactions have description ending with "(pending)".
    pendingTransactions = await db
      .select({
        id: walletTransactions.id,
        walletId: walletTransactions.walletId,
        externalRef: walletTransactions.externalRef,
        amountKobo: walletTransactions.amountKobo,
        description: walletTransactions.description,
        createdAt: walletTransactions.createdAt,
      })
      .from(walletTransactions)
      .where(
        and(
          // Description ends with "(pending)" — set by the /initiate endpoint
          eq(walletTransactions.type, "topup"),
          lt(walletTransactions.createdAt, fiveMinutesAgo)
        )
      )
      .limit(100); // Process at most 100 per run to avoid long-running jobs

    // Filter to only those with "(pending)" in description
    pendingTransactions = pendingTransactions.filter(
      t => t.description?.includes("(pending)") && t.externalRef?.startsWith("NP-")
    );
  } catch (err) {
    const msg = `Failed to query pending transactions: ${(err as Error).message}`;
    console.error(`[Reconcile] ${msg}`);
    result.errors.push(msg);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(`[Reconcile] Found ${pendingTransactions.length} pending transactions to process`);
  result.processed = pendingTransactions.length;

  if (pendingTransactions.length === 0) {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── 2. Process each pending transaction ───────────────────────────────────
  for (const txn of pendingTransactions) {
    const ref = txn.externalRef ?? "";

    // Unified reference format: NP-<PROVIDER>-<userId>-<ts>[-rand] (P0-4)
    const parsed = parsePaymentReference(ref);
    const providerSlug = parsed?.provider as PaymentProviderSlug | undefined;

    if (!providerSlug) {
      console.warn(`[Reconcile] Unparseable payment reference: ${ref}`);
      result.skipped++;
      continue;
    }

    try {
      // ── 3. Verify with provider API ────────────────────────────────────────
      const provider = getProvider(providerSlug);
      const secretKey = getProviderSecretKey(providerSlug);

      // Fail closed (P0-2): a failed provider verification is NEVER treated
      // as success. There is no demo-mode override.
      const verifyResult = await provider.verifyTransaction(ref, secretKey);

      if (!verifyResult.success || verifyResult.status !== "success") {
        console.log(`[Reconcile] Transaction ${ref} not yet successful (status: ${verifyResult.status}) — skipping`);
        result.skipped++;
        continue;
      }

      // ── 4. Get the wallet account ──────────────────────────────────────────
      const walletRows = await db
        .select({
          id: walletAccounts.id,
          balanceKobo: walletAccounts.balanceKobo,
          userId: walletAccounts.userId,
        })
        .from(walletAccounts)
        .where(eq(walletAccounts.id, txn.walletId))
        .limit(1);

      if (walletRows.length === 0) {
        // Try to find by email if we have it from the verify result
        if (verifyResult.email) {
          const userRows = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, verifyResult.email))
            .limit(1);

          if (userRows.length === 0) {
            console.warn(`[Reconcile] No user found for email ${verifyResult.email} — skipping ${ref}`);
            result.skipped++;
            continue;
          }

          // Find or create wallet for this user
          const userWalletRows = await db
            .select({ id: walletAccounts.id, balanceKobo: walletAccounts.balanceKobo })
            .from(walletAccounts)
            .where(eq(walletAccounts.userId, userRows[0]!.id))
            .limit(1);

          if (userWalletRows.length === 0) {
            console.warn(`[Reconcile] No wallet for user ${userRows[0]!.id} — skipping ${ref}`);
            result.skipped++;
            continue;
          }

          // Credit the wallet atomically (P0-4): SQL-side increment inside a
          // transaction — no read-modify-write balance math in JS.
          const newBalance = await db.transaction(async (tx) => {
            const upd = await tx
              .update(walletAccounts)
              .set({
                balanceKobo: sql`${walletAccounts.balanceKobo} + ${verifyResult.amountKobo}`,
                updatedAt: new Date(),
              })
              .where(eq(walletAccounts.id, userWalletRows[0]!.id))
              .returning({ balanceKobo: walletAccounts.balanceKobo });
            const nb = upd[0]?.balanceKobo ?? 0;
            await tx
              .update(walletTransactions)
              .set({
                walletId: userWalletRows[0]!.id,
                balanceAfterKobo: nb,
                description: txn.description?.replace("(pending)", "(reconciled)") ?? "Wallet top-up (reconciled)",
              })
              .where(eq(walletTransactions.id, txn.id));
            return nb;
          });

          // Emit WebSocket event
          const emitter = getKycStatusEmitter();
          emitter.emit("wallet_credited", {
            userId: userRows[0]!.id,
            amountKobo: verifyResult.amountKobo,
            newBalanceKobo: newBalance,
            reference: ref,
            provider: providerSlug,
          });

          // Check for tier upgrade and emit tier_upgraded event
          const oldTierByEmail = getWalletTier(userWalletRows[0]!.balanceKobo);
          const newTierByEmail = getWalletTier(newBalance);
          if (TIER_RANK[newTierByEmail] > TIER_RANK[oldTierByEmail]) {
            emitter.emit("tier_upgraded", {
              userId: userRows[0]!.id,
              oldTier: oldTierByEmail,
              newTier: newTierByEmail,
              newBalanceKobo: newBalance,
            });
            console.log(`[Reconcile] ↑ Tier upgrade for user ${userRows[0]!.id}: ${oldTierByEmail} → ${newTierByEmail}`);
          }

          console.log(`[Reconcile] ✓ Credited ₦${verifyResult.amountKobo / 100} to user ${userRows[0]!.id} via reconciliation (ref: ${ref})`);
          result.credited++;
          continue;
        }

        console.warn(`[Reconcile] Wallet ${txn.walletId} not found — skipping ${ref}`);
        result.skipped++;
        continue;
      }

      // ── 5. Credit the wallet atomically (P0-4) ─────────────────────────────
      const wallet = walletRows[0]!;
      const newBalance = await db.transaction(async (tx) => {
        const upd = await tx
          .update(walletAccounts)
          .set({
            balanceKobo: sql`${walletAccounts.balanceKobo} + ${verifyResult.amountKobo}`,
            updatedAt: new Date(),
          })
          .where(eq(walletAccounts.id, wallet.id))
          .returning({ balanceKobo: walletAccounts.balanceKobo });
        const nb = upd[0]?.balanceKobo ?? 0;
        await tx
          .update(walletTransactions)
          .set({
            balanceAfterKobo: nb,
            description: txn.description?.replace("(pending)", "(reconciled)") ?? "Wallet top-up (reconciled)",
          })
          .where(eq(walletTransactions.id, txn.id));
        return nb;
      });

      // Emit WebSocket event to notify the user's wallet page
      const emitter = getKycStatusEmitter();
      emitter.emit("wallet_credited", {
        userId: wallet.userId,
        amountKobo: verifyResult.amountKobo,
        newBalanceKobo: newBalance,
        reference: ref,
        provider: providerSlug,
      });

      // Check for tier upgrade and emit tier_upgraded event
      const oldTier = getWalletTier(wallet.balanceKobo);
      const newTier = getWalletTier(newBalance);
      if (TIER_RANK[newTier] > TIER_RANK[oldTier]) {
        emitter.emit("tier_upgraded", {
          userId: wallet.userId,
          oldTier,
          newTier,
          newBalanceKobo: newBalance,
        });
        console.log(`[Reconcile] ↑ Tier upgrade for wallet ${wallet.id}: ${oldTier} → ${newTier}`);
      }

      console.log(`[Reconcile] ✓ Credited ₦${verifyResult.amountKobo / 100} to wallet ${wallet.id} (ref: ${ref})`);
      result.credited++;

    } catch (err) {
      const msg = `Failed to reconcile ${ref}: ${(err as Error).message}`;
      console.error(`[Reconcile] ${msg}`);
      result.errors.push(msg);
      result.failed++;
    }
  }

  result.durationMs = Date.now() - startTime;

  // ── 6. Summary ────────────────────────────────────────────────────────────
  const summary = [
    `Reconciliation complete in ${result.durationMs}ms.`,
    `Processed: ${result.processed} | Credited: ${result.credited} | Skipped: ${result.skipped} | Failed: ${result.failed}`,
    ...(result.errors.length > 0 ? [`Errors: ${result.errors.join("; ")}`] : []),
  ].join(" ");

  console.log(`[Reconcile] ${summary}`);

  // Notify owner if any transactions were credited or failed
  if (result.credited > 0 || result.failed > 0) {
    try {
      await notifyOwner({
        title: `NigerianPass Reconciliation — ${result.credited} credited, ${result.failed} failed`,
        content: summary,
      });
    } catch {
      // Non-fatal — notification failure should not affect the job result
    }
  }

  return result;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let reconcileInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the nightly reconciliation scheduler.
 * Runs at 02:00 WAT (UTC+1) = 01:00 UTC every day.
 * Also runs an initial pass 30 seconds after server startup.
 */
export function startReconciliationScheduler(): void {
  if (reconcileInterval) {
    console.log("[Reconcile] Scheduler already running");
    return;
  }

  // Initial run 30 seconds after startup (catches any transactions missed during downtime)
  const initialDelay = setTimeout(async () => {
    console.log("[Reconcile] Running initial reconciliation pass...");
    const startedAt = new Date();
    try {
      const result = await reconcile();
      const status =
        result.errors.length > 0 && result.credited === 0 ? "failed" :
        result.processed === 0 ? "empty" :
        result.failed > 0 ? "partial" : "success";
      await createReconciliationRun({
        triggeredBy: "scheduled",
        status,
        processed: result.processed,
        credited: result.credited,
        failed: result.failed,
        skipped: result.skipped,
        errors: result.errors,
        durationMs: result.durationMs,
        triggeredByUserId: null,
        startedAt,
      }).catch(e => console.warn("[Reconcile] Failed to persist initial-pass run:", e));
    } catch (err) {
      console.error("[Reconcile] Initial pass failed:", err);
    }
  }, 30_000);

  // Nightly run: check every hour if it's time for the 02:00 WAT run
  reconcileInterval = setInterval(async () => {
    const now = new Date();
    // WAT is UTC+1; 02:00 WAT = 01:00 UTC
    const isReconcileHour = now.getUTCHours() === 1 && now.getUTCMinutes() < 5;
    if (!isReconcileHour) return;

    console.log("[Reconcile] Running nightly reconciliation (02:00 WAT)...");
    const startedAt = new Date();
    try {
      const result = await reconcile();
      const status =
        result.errors.length > 0 && result.credited === 0 ? "failed" :
        result.processed === 0 ? "empty" :
        result.failed > 0 ? "partial" : "success";
      await createReconciliationRun({
        triggeredBy: "scheduled",
        status,
        processed: result.processed,
        credited: result.credited,
        failed: result.failed,
        skipped: result.skipped,
        errors: result.errors,
        durationMs: result.durationMs,
        triggeredByUserId: null,
        startedAt,
      }).catch(e => console.warn("[Reconcile] Failed to persist nightly run:", e));
    } catch (err) {
      console.error("[Reconcile] Nightly run failed:", err);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  console.log("[Reconcile] Scheduler started — nightly run at 02:00 WAT, initial pass in 30s");
}

/**
 * Stop the reconciliation scheduler (for graceful shutdown).
 */
export function stopReconciliationScheduler(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
    console.log("[Reconcile] Scheduler stopped");
  }
}
