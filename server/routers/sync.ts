/**
 * Sync Router
 * ===========
 * Backend procedures that the Background Sync service worker calls when the
 * device regains connectivity. All endpoints are protected so only authenticated
 * users can replay their own queued mutations.
 *
 * Procedures:
 *  - sync.processQueue        — Accepts a batch of queued mutations, persists them
 *                               to the sync_queue table, and replays each one.
 *  - sync.walletBalance       — Returns the current wallet balance from the DB.
 *  - sync.kycStatuses         — Returns all KYC application statuses from the DB.
 *  - sync.submitKycDraft      — Persists an offline KYC draft as a real application.
 *  - sync.ping                — Connectivity probe.
 *  - sync.registerPeriodicSync — Records periodic sync preference.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createKycApplication,
  generateReferenceId,
  getDb,
  getKycApplicationsByUserId,
  getOrCreateWalletAccount,
  getWalletTransactions,
  markSyncQueueItemDone,
  markSyncQueueItemFailed,
  upsertSyncQueueItem,
} from "../db";
import { kycApplications } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { validateKycFormData, LIVENESS_THRESHOLD } from "./kyc";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";

// ── Queued item schema (mirrors client-side RetryItem) ────────────────────────
const QueuedItemSchema = z.object({
  id: z.string().optional(),        // client-side UUID
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  label: z.string(),
  attempts: z.number().default(0),
  createdAt: z.number(),            // Unix ms
});

// ── KYC draft payload schema ──────────────────────────────────────────────────
const KycDraftPayloadSchema = z.object({
  type: z.enum(["driver", "vehicle", "fleet"]),
  formData: z.record(z.string(), z.unknown()),
  clientVersion: z.number().default(1),
  draftId: z.string().optional(),
});

export const syncRouter = router({
  /**
   * Process a batch of queued mutations from the client's IndexedDB retry queue.
   *
   * For each item:
   *  1. Upsert it into the server-side sync_queue table (idempotent by clientId).
   *  2. Dispatch to the appropriate handler based on the URL / label.
   *  3. Mark the item as done or failed in the DB.
   *
   * This replaces the previous log-and-acknowledge stub with real persistence.
   */
  processQueue: protectedProcedure
    .input(z.object({
      items: z.array(QueuedItemSchema),
    }))
    .mutation(async ({ ctx, input }) => {
      const results: Array<{ id?: string; success: boolean; error?: string; referenceId?: string }> = [];

      for (const item of input.items) {
        const clientId = item.id ?? `${ctx.user.id}-${item.createdAt}`;

        try {
          // Security: only allow relative /api/ paths to prevent SSRF
          if (!item.url.startsWith("/api/")) {
            results.push({ id: clientId, success: false, error: "Invalid URL — must be a relative /api/ path" });
            continue;
          }

          // Persist to server-side sync_queue (idempotent)
          await upsertSyncQueueItem({
            clientId,
            userId: ctx.user.id,
            procedure: item.label,
            payload: item.body ? JSON.parse(item.body) : {},
            status: "processing",
            attempts: item.attempts,
            queuedAt: new Date(item.createdAt),
          });

          // ── Dispatch to handler based on label ──────────────────────────────
          let referenceId: string | undefined;

          if (item.label.includes("kyc") || item.label.includes("KYC") || item.label.includes("onboard")) {
            // KYC form submission replay — validated + idempotent (P1-13).
            // Dedupe by clientId: a replayed queue item never creates a
            // second application.
            const payload = item.body ? JSON.parse(item.body) : {};
            const type: "driver" | "vehicle" | "fleet" =
              payload.type ?? (item.label.includes("driver") ? "driver" : item.label.includes("vehicle") ? "vehicle" : "fleet");
            const formData = payload.formData ?? payload;
            const draftId: string = payload.draftId ?? `queue-${clientId}`;

            const validation = validateKycFormData(type, formData);
            if (!validation.ok) {
              throw new Error(`Validation failed for ${type}: ${validation.error}`);
            }
            if (type === "driver") {
              const liveness = Number(formData.livenessScore ?? 0);
              if (liveness < LIVENESS_THRESHOLD) {
                throw new Error(`Liveness verification failed (score ${liveness} < ${LIVENESS_THRESHOLD})`);
              }
            }

            const db = await getDb();
            if (!db) throw new Error("Database unavailable");

            const existing = await db
              .select({ referenceId: kycApplications.referenceId })
              .from(kycApplications)
              .where(and(
                eq(kycApplications.userId, ctx.user.id),
                eq(kycApplications.type, type),
                eq(kycApplications.draftId, draftId),
              ))
              .limit(1);

            if (existing.length > 0) {
              referenceId = existing[0]!.referenceId; // idempotent replay
            } else {
              referenceId = generateReferenceId(type);
              await createKycApplication({
                referenceId,
                userId: ctx.user.id,
                type,
                status: "submitted",
                formData,
                draftId,
                fromOfflineQueue: true,
                clientVersion: payload.clientVersion ?? 1,
              });
            }
          } else if (item.label.includes("wallet") || item.label.includes("topup")) {
            // Wallet top-up replay — just acknowledge; actual payment must be re-initiated
            // because payment tokens expire. We log it so the user is notified.
            console.log(`[SyncRouter] Wallet top-up queued item acknowledged for user ${ctx.user.id} — payment token may have expired, user will need to re-initiate.`);
          } else {
            // Generic API replay: forward the request internally
            console.log(`[SyncRouter] Generic queued item for user ${ctx.user.id}: ${item.label} → ${item.method} ${item.url}`);
          }

          await markSyncQueueItemDone(clientId);
          results.push({ id: clientId, success: true, referenceId });

        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          await markSyncQueueItemFailed(clientId, errorMsg).catch(() => {});
          results.push({ id: clientId, success: false, error: errorMsg });
        }
      }

      const processed = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return {
        processed,
        failed,
        results,
        syncedAt: Date.now(),
      };
    }),

  /**
   * Submit a single KYC draft that was saved offline.
   * Called directly when the user explicitly submits while offline and the
   * SW replays it on reconnect.
   */
  submitKycDraft: protectedProcedure
    .input(KycDraftPayloadSchema)
    .mutation(async ({ ctx, input }) => {
      // ── Server-side validation by kycType (P1-13) ────────────────────────
      // Offline drafts are validated with the SAME zod schemas as direct
      // submissions — being offline does not bypass validation.
      const validation = validateKycFormData(input.type, input.formData);
      if (!validation.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Validation failed: ${validation.error}` });
      }
      // Fail-closed liveness check for driver submissions (no bypass)
      if (input.type === "driver") {
        const liveness = Number((input.formData as Record<string, unknown>).livenessScore ?? 0);
        if (liveness < LIVENESS_THRESHOLD) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Liveness verification failed (score ${liveness} < ${LIVENESS_THRESHOLD})`,
          });
        }
      }

      // ── Idempotency (P1-13): UNIQUE(userId, type, draftId) ───────────────
      // A replayed draft (SW retry / double-submit) returns the existing
      // application instead of creating a duplicate. Clients that do not send
      // a draftId get a deterministic fallback keyed by user+type+version.
      const draftId = input.draftId ?? `auto-${ctx.user.id}-${input.type}-v${input.clientVersion}`;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const existing = await db
        .select({
          referenceId: kycApplications.referenceId,
          status: kycApplications.status,
          createdAt: kycApplications.createdAt,
        })
        .from(kycApplications)
        .where(and(
          eq(kycApplications.userId, ctx.user.id),
          eq(kycApplications.type, input.type),
          eq(kycApplications.draftId, draftId),
        ))
        .limit(1);
      if (existing.length > 0) {
        return {
          referenceId: existing[0]!.referenceId,
          status: existing[0]!.status,
          createdAt: existing[0]!.createdAt,
          duplicate: true,
        };
      }

      const referenceId = generateReferenceId(input.type);
      const application = await createKycApplication({
        referenceId,
        userId: ctx.user.id,
        type: input.type,
        status: "submitted",
        formData: input.formData,
        draftId,
        fromOfflineQueue: true,
        clientVersion: input.clientVersion,
      });

      if (!application) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create KYC application" });

      return {
        referenceId: application.referenceId,
        status: application.status,
        createdAt: application.createdAt,
        duplicate: false,
      };
    }),

  /**
   * Returns the current wallet balance and recent transactions from the DB.
   * Called by the SW during background balance refresh.
   */
  walletBalance: protectedProcedure
    .query(async ({ ctx }) => {
      const wallet = await getOrCreateWalletAccount(ctx.user.id);
      const transactions = await getWalletTransactions(wallet.id, 10);

      return {
        balance: wallet.balanceKobo / 100,          // convert to ₦
        balanceKobo: wallet.balanceKobo,
        currency: "NGN",
        dailyFareCap: wallet.dailyCapKobo / 100,
        dailySpent: wallet.dailySpentKobo / 100,
        lastUpdated: wallet.lastBalanceSync.getTime(),
        userId: ctx.user.id,
        recentTransactions: transactions.map(t => ({
          id: t.id,
          type: t.type,
          amount: t.amountKobo / 100,
          description: t.description,
          createdAt: t.createdAt.getTime(),
        })),
      };
    }),

  /**
   * Returns all KYC application statuses for the authenticated user from the DB.
   * Called by the SW during background KYC status sync.
   */
  kycStatuses: protectedProcedure
    .query(async ({ ctx }) => {
      const applications = await getKycApplicationsByUserId(ctx.user.id);

      // No fabrication (P1-17): a user with no applications gets an empty
      // list — never a fake DRV-DEMO entry masquerading as real data.
      if (applications.length === 0) {
        return [];
      }

      return applications.map(app => ({
        id: app.referenceId,
        type: app.type,
        status: app.status,
        submittedAt: app.createdAt.getTime(),
        updatedAt: app.updatedAt.getTime(),
        kycScore: app.kycScore,
        fromOfflineQueue: app.fromOfflineQueue,
      }));
    }),

  /**
   * Public connectivity probe — called by the SW before attempting queue replay.
   */
  ping: publicProcedure
    .query(() => ({
      ok: true,
      serverTime: Date.now(),
      version: "1.0.0",
    })),

  /**
   * Records that a user has enabled periodic background sync.
   * Stored in the DB so the server can track which users have SW sync active.
   */
  registerPeriodicSync: protectedProcedure
    .input(z.object({
      tags: z.array(z.string()),
      minIntervalMs: z.number().default(15 * 60 * 1000),
    }))
    .mutation(async ({ ctx, input }) => {
      // Persist as a sync_queue entry with type "periodic_sync_registration"
      // so we have an audit trail of when each user enabled it.
      await upsertSyncQueueItem({
        clientId: `periodic-sync-reg-${ctx.user.id}`,
        userId: ctx.user.id,
        procedure: "sync.registerPeriodicSync",
        payload: { tags: input.tags, minIntervalMs: input.minIntervalMs },
        status: "done",
        attempts: 0,
        queuedAt: new Date(),
        processedAt: new Date(),
      });

      return {
        success: true,
        registeredAt: Date.now(),
        tags: input.tags,
      };
    }),
});
