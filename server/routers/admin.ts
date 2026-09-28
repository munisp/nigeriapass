/**
 * Admin Router
 * ============
 * Protected procedures for admin users to review and act on KYC applications.
 *
 * Procedures:
 *  - admin.listApplications   — Paginated list of all KYC applications with filters
 *  - admin.getApplication     — Full detail of a single application
 *  - admin.approveApplication — Approve a KYC application and push live status update
 *  - admin.rejectApplication  — Reject a KYC application with reason and push live update
 *  - admin.requestResubmission — Ask the applicant to fix and resubmit
 *  - admin.setKycScore        — Manually set the KYC score for an application
 *  - admin.stats              — Aggregate stats for the analytics dashboard
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getKycApplicationsByUserId,
  getKycApplicationByReferenceId,
  updateKycApplicationStatus,
  getDb,
} from "../db";
import { kycApplications, reconciliationRuns } from "../../drizzle/schema";
import { desc, eq, and, like, inArray, count, sql, gte } from "drizzle-orm";
import { getKycStatusEmitter } from "../events/kycEvents";
import { sendSms, kycApprovedMessage, kycRejectedMessage, kycResubmissionMessage } from "../services/sms";
import { reconcile } from "../jobs/reconcile";
import { users } from "../../drizzle/schema";
import { asc } from "drizzle-orm";
import { createReconciliationRun, getReconciliationRuns, resolveReconciliationRun } from "../db";
import { audit } from "../_core/audit";
import { refunds } from "../../drizzle/schema";

// ── Admin-only guard ──────────────────────────────────────────────────────────
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }
  return next({ ctx });
});

// ── Input schemas ─────────────────────────────────────────────────────────────
const ReviewDecisionSchema = z.object({
  referenceId: z.string().min(1),
  reviewNotes: z.string().optional(),
  kycScore: z.number().min(0).max(100).optional(),
});


/**
 * Extract the applicant phone from formData regardless of which key the
 * per-type form used (P1-16): driver uses "phone", fleet uses
 * "contact_phone", vehicle uses "owner_phone". Also normalises the contact
 * name across keys.
 */
function applicantContact(formData: unknown): { phone?: string; name?: string } {
  const fd = (formData ?? {}) as Record<string, unknown>;
  return {
    phone: (fd.contact_phone ?? fd.phone ?? fd.owner_phone ?? fd.contactPhone) as string | undefined,
    name: (fd.contact_name ?? fd.full_name ?? fd.owner_name ?? fd.business_name) as string | undefined,
  };
}

export const adminRouter = router({
  /**
   * Paginated list of all KYC applications with optional filters.
   */
  listApplications: adminProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      status: z.enum(["draft", "submitted", "under_review", "approved", "rejected", "requires_resubmission"]).optional(),
      type: z.enum(["driver", "vehicle", "fleet"]).optional(),
      search: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const offset = (input.page - 1) * input.pageSize;

      // Build dynamic where conditions
      const conditions = [];
      if (input.status) conditions.push(eq(kycApplications.status, input.status));
      if (input.type) conditions.push(eq(kycApplications.type, input.type));
      if (input.search) {
        conditions.push(like(kycApplications.referenceId, `%${input.search}%`));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db.select({
          id: kycApplications.id,
          referenceId: kycApplications.referenceId,
          userId: kycApplications.userId,
          type: kycApplications.type,
          status: kycApplications.status,
          kycScore: kycApplications.kycScore,
          reviewedBy: kycApplications.reviewedBy,
          reviewedAt: kycApplications.reviewedAt,
          reviewNotes: kycApplications.reviewNotes,
          formData: kycApplications.formData,
          fromOfflineQueue: kycApplications.fromOfflineQueue,
          createdAt: kycApplications.createdAt,
          updatedAt: kycApplications.updatedAt,
        })
          .from(kycApplications)
          .where(whereClause)
          .orderBy(desc(kycApplications.createdAt))
          .limit(input.pageSize)
          .offset(offset),
        db.select({ total: count() })
          .from(kycApplications)
          .where(whereClause),
      ]);

      const total = totalRows[0]?.total ?? 0;

      return {
        applications: rows.map(r => ({
          ...r,
          createdAt: r.createdAt.getTime(),
          updatedAt: r.updatedAt.getTime(),
          reviewedAt: r.reviewedAt?.getTime() ?? null,
        })),
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          totalPages: Math.ceil(total / input.pageSize),
        },
      };
    }),

  /**
   * Full detail of a single application including form data.
   */
  getApplication: adminProcedure
    .input(z.object({ referenceId: z.string() }))
    .query(async ({ input }) => {
      const app = await getKycApplicationByReferenceId(input.referenceId);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
      return {
        ...app,
        createdAt: app.createdAt.getTime(),
        updatedAt: app.updatedAt.getTime(),
        reviewedAt: app.reviewedAt?.getTime() ?? null,
      };
    }),

  /**
   * Approve a KYC application.
   * Updates the DB status to "approved" and emits a WebSocket event
   * to the applicant's status page so it updates live without a refresh.
   */
  approveApplication: adminProcedure
    .input(ReviewDecisionSchema)
    .mutation(async ({ ctx, input }) => {
      const app = await getKycApplicationByReferenceId(input.referenceId);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

      if (app.status === "approved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Application is already approved" });
      }

      await updateKycApplicationStatus(input.referenceId, "approved", {
        reviewNotes: input.reviewNotes,
        reviewedBy: ctx.user.id,
        kycScore: input.kycScore,
      });
      void audit(ctx, "kyc.approve", "kyc_application", input.referenceId, { type: app.type, from: app.status });

      // Emit live WebSocket push to the applicant's status page
      const emitter = getKycStatusEmitter();
      emitter.emit("status_changed", {
        referenceId: input.referenceId,
        userId: app.userId,
        newStatus: "approved",
        reviewNotes: input.reviewNotes ?? null,
        kycScore: input.kycScore ?? null,
        reviewedAt: Date.now(),
        reviewedBy: ctx.user.name ?? "Admin",
      });

      // Send SMS notification to applicant if phone is available in formData
      const approvePhone = applicantContact(app.formData).phone;
      if (approvePhone) {
        const approveContactName = applicantContact(app.formData).name;
        sendSms(approvePhone, kycApprovedMessage(input.referenceId, approveContactName)).catch((err) =>
          console.error(`[Admin] SMS approve notification failed for ${input.referenceId}:`, err)
        );
      }

      return {
        success: true,
        referenceId: input.referenceId,
        newStatus: "approved" as const,
        reviewedAt: Date.now(),
      };
    }),

  /**
   * Reject a KYC application with a mandatory reason.
   * Emits a WebSocket event to the applicant's status page.
   */
  rejectApplication: adminProcedure
    .input(ReviewDecisionSchema.extend({
      reviewNotes: z.string().min(10, "Please provide a rejection reason (min 10 characters)"),
    }))
    .mutation(async ({ ctx, input }) => {
      const app = await getKycApplicationByReferenceId(input.referenceId);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

      if (app.status === "rejected") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Application is already rejected" });
      }

      await updateKycApplicationStatus(input.referenceId, "rejected", {
        reviewNotes: input.reviewNotes,
        reviewedBy: ctx.user.id,
        kycScore: input.kycScore,
      });
      void audit(ctx, "kyc.reject", "kyc_application", input.referenceId, { type: app.type, from: app.status });

      const emitter = getKycStatusEmitter();
      emitter.emit("status_changed", {
        referenceId: input.referenceId,
        userId: app.userId,
        newStatus: "rejected",
        reviewNotes: input.reviewNotes,
        kycScore: input.kycScore ?? null,
        reviewedAt: Date.now(),
        reviewedBy: ctx.user.name ?? "Admin",
      });

      // Send SMS notification to applicant
      const rejectPhone = applicantContact(app.formData).phone;
      if (rejectPhone) {
        sendSms(rejectPhone, kycRejectedMessage(input.referenceId, input.reviewNotes, applicantContact(app.formData).name)).catch((err) =>
          console.error(`[Admin] SMS reject notification failed for ${input.referenceId}:`, err)
        );
      }

      return {
        success: true,
        referenceId: input.referenceId,
        newStatus: "rejected" as const,
        reviewedAt: Date.now(),
      };
    }),

  /**
   * Request resubmission — marks the application as requiring fixes.
   */
  requestResubmission: adminProcedure
    .input(ReviewDecisionSchema.extend({
      reviewNotes: z.string().min(10, "Please describe what needs to be fixed"),
    }))
    .mutation(async ({ ctx, input }) => {
      const app = await getKycApplicationByReferenceId(input.referenceId);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

      await updateKycApplicationStatus(input.referenceId, "requires_resubmission", {
        reviewNotes: input.reviewNotes,
        reviewedBy: ctx.user.id,
        kycScore: input.kycScore,
      });
      void audit(ctx, "kyc.resubmit", "kyc_application", input.referenceId, { type: app.type, from: app.status });

      const emitter = getKycStatusEmitter();
      emitter.emit("status_changed", {
        referenceId: input.referenceId,
        userId: app.userId,
        newStatus: "requires_resubmission",
        reviewNotes: input.reviewNotes,
        kycScore: input.kycScore ?? null,
        reviewedAt: Date.now(),
        reviewedBy: ctx.user.name ?? "Admin",
      });

      // Send SMS notification to applicant
      const resubPhone = applicantContact(app.formData).phone;
      if (resubPhone) {
        sendSms(resubPhone, kycResubmissionMessage(input.referenceId, input.reviewNotes, applicantContact(app.formData).name)).catch((err) =>
          console.error(`[Admin] SMS resubmission notification failed for ${input.referenceId}:`, err)
        );
      }

      return {
        success: true,
        referenceId: input.referenceId,
        newStatus: "requires_resubmission" as const,
      };
    }),

  /**
   * Set the KYC score for an application without changing its status.
   */
  setKycScore: adminProcedure
    .input(z.object({
      referenceId: z.string(),
      kycScore: z.number().min(0).max(100),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      await db.update(kycApplications)
        .set({ kycScore: input.kycScore })
        .where(eq(kycApplications.referenceId, input.referenceId));

      return { success: true, referenceId: input.referenceId, kycScore: input.kycScore };
    }),

  /**
   * List all users with pagination and search.
   */
  listUsers: adminProcedure
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      search: z.string().optional(),
      role: z.enum(["user", "admin"]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const { users } = await import("../../drizzle/schema");
      const { asc } = await import("drizzle-orm");

      const offset = (input.page - 1) * input.pageSize;
      const conditions = [];
      if (input.role) conditions.push(eq(users.role, input.role));
      if (input.search) {
        const { or } = await import("drizzle-orm");
        conditions.push(or(
          like(users.name, `%${input.search}%`),
          like(users.email, `%${input.search}%`),
          like(users.openId, `%${input.search}%`),
        ));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db.select({
          id: users.id,
          openId: users.openId,
          name: users.name,
          email: users.email,
          role: users.role,
          loginMethod: users.loginMethod,
          createdAt: users.createdAt,
          lastSignedIn: users.lastSignedIn,
        })
          .from(users)
          .where(whereClause)
          .orderBy(desc(users.createdAt))
          .limit(input.pageSize)
          .offset(offset),
        db.select({ total: count() }).from(users).where(whereClause),
      ]);

      const total = totalRows[0]?.total ?? 0;
      return {
        users: rows.map(r => ({
          ...r,
          createdAt: r.createdAt.getTime(),
          lastSignedIn: r.lastSignedIn.getTime(),
        })),
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          totalPages: Math.ceil(total / input.pageSize),
        },
      };
    }),

  /**
   * Promote or demote a user's role.
   */
  setUserRole: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      role: z.enum(["user", "admin"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Prevent self-demotion
      if (input.userId === ctx.user.id && input.role === "user") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot demote your own admin account" });
      }

      const { users } = await import("../../drizzle/schema");
      const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, input.userId)).limit(1);
      await db.update(users)
        .set({ role: input.role })
        .where(eq(users.id, input.userId));
      void audit(ctx, "user.setRole", "user", input.userId, { from: target?.role ?? null, to: input.role });

      return { success: true, userId: input.userId, newRole: input.role };
    }),

  /**
   * Get per-user KYC application stats.
   */
  getUserStats: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const apps = await db.select({
        status: kycApplications.status,
        type: kycApplications.type,
        referenceId: kycApplications.referenceId,
        createdAt: kycApplications.createdAt,
      })
        .from(kycApplications)
        .where(eq(kycApplications.userId, input.userId))
        .orderBy(desc(kycApplications.createdAt))
        .limit(20);

      return {
        total: apps.length,
        applications: apps.map(a => ({ ...a, createdAt: a.createdAt.getTime() })),
      };
    }),

  /**
   * Aggregate stats for the admin analytics dashboard.
   */
  stats: adminProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) {
        // Explicitly flagged demo data when DB is unavailable (P1-17)
        return { ...getDemoStats(), is_demo: true as const };
      }

      try {
        const [statusCounts, typeCounts, recentActivity] = await Promise.all([
          db.select({
            status: kycApplications.status,
            count: count(),
          })
            .from(kycApplications)
            .groupBy(kycApplications.status),

          db.select({
            type: kycApplications.type,
            count: count(),
          })
            .from(kycApplications)
            .groupBy(kycApplications.type),

          db.select({
            id: kycApplications.id,
            referenceId: kycApplications.referenceId,
            type: kycApplications.type,
            status: kycApplications.status,
            createdAt: kycApplications.createdAt,
          })
            .from(kycApplications)
            .orderBy(desc(kycApplications.createdAt))
            .limit(10),
        ]);

        const statusMap = Object.fromEntries(statusCounts.map(r => [r.status, r.count]));
        const typeMap = Object.fromEntries(typeCounts.map(r => [r.type, r.count]));
        const total = statusCounts.reduce((sum, r) => sum + r.count, 0);
        const approved = statusMap["approved"] ?? 0;

        return {
          total,
          pending: (statusMap["submitted"] ?? 0) + (statusMap["under_review"] ?? 0),
          approved,
          rejected: statusMap["rejected"] ?? 0,
          requiresResubmission: statusMap["requires_resubmission"] ?? 0,
          approvalRate: total > 0 ? Math.round((approved / total) * 100) : 0,
          byType: {
            driver: typeMap["driver"] ?? 0,
            vehicle: typeMap["vehicle"] ?? 0,
            fleet: typeMap["fleet"] ?? 0,
          },
          recentActivity: recentActivity.map(r => ({
            ...r,
            createdAt: r.createdAt.getTime(),
          })),
        };
      } catch {
        return { ...getDemoStats(), is_demo: true as const };
      }
    }),

  // ── Manual reconciliation trigger ───────────────────────────────────────────────────────────────────
  runReconciliation: adminProcedure.mutation(async ({ ctx }) => {
    try {
      const result = await reconcile();

      // Determine overall status
      const status =
        result.errors.length > 0 && result.credited === 0 ? "failed" :
        result.processed === 0 ? "empty" :
        result.failed > 0 ? "partial" : "success";

      // Persist run to DB (non-fatal if DB is unavailable)
      await createReconciliationRun({
        triggeredBy: "manual",
        status,
        processed: result.processed,
        credited: result.credited,
        failed: result.failed,
        skipped: result.skipped,
        errors: result.errors,
        durationMs: result.durationMs,
        triggeredByUserId: ctx.user.id,
        startedAt: new Date(Date.now() - result.durationMs),
      }).catch(e => console.warn("[Admin] Failed to persist reconciliation run:", e));

      return {
        success: true,
        status,
        ...result,
      };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Reconciliation failed: ${(err as Error).message}`,
      });
    }
  }),

  /**
   * Get the last N reconciliation runs from the database.
   * Used by the AdminReconciliation page to display server-side history.
   */
  getReconciliationHistory: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const runs = await getReconciliationRuns(input.limit);
      return runs.map(r => ({
        id: r.id,
        triggeredBy: r.triggeredBy,
        status: r.status,
        processed: r.processed,
        credited: r.credited,
        failed: r.failed,
        skipped: r.skipped,
        errors: r.errors as string[],
        durationMs: r.durationMs,
        triggeredByUserId: r.triggeredByUserId,
        startedAt: r.startedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      }));
    }),

  /**
   * Get unresolved reconciliation alerts.
   * An alert is raised when:
   *  - A run has failed > 0 transactions, OR
   *  - A run took longer than 30 seconds (durationMs > 30_000)
   * Returns the last 5 alerting runs plus a summary count.
   */
  getReconciliationAlerts: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) {
      return { alerts: [], totalAlerts: 0, hasUnresolved: false };
    }

    try {
      const { reconciliationRuns } = await import("../../drizzle/schema");
      const { or, gt } = await import("drizzle-orm");

      // Fetch the last 50 runs to scan for alerts
      const recentRuns = await db
        .select()
        .from(reconciliationRuns)
        .orderBy(desc(reconciliationRuns.startedAt))
        .limit(50);

      const SLOW_THRESHOLD_MS = 30_000;

      // Only surface unresolved alerts (resolvedAt is null)
      const alertingRuns = recentRuns.filter(
        r =>
          r.resolvedAt === null &&
          (r.failed > 0 || r.durationMs > SLOW_THRESHOLD_MS || r.status === "failed")
      );

      const alerts = alertingRuns.slice(0, 5).map(r => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        status: r.status,
        failed: r.failed,
        durationMs: r.durationMs,
        triggeredBy: r.triggeredBy,
        reason: r.status === "failed"
          ? "Run failed entirely"
          : r.durationMs > SLOW_THRESHOLD_MS
          ? `Slow run: ${(r.durationMs / 1000).toFixed(1)}s (threshold: 30s)`
          : `${r.failed} transaction(s) failed to credit`,
        errors: (r.errors as string[]).slice(0, 3),
      }));

      return {
        alerts,
        totalAlerts: alertingRuns.length,
        hasUnresolved: alertingRuns.length > 0,
      };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load reconciliation alerts: ${(err as Error).message}`,
      });
    }
  }),

  // ── Refunds (P1-19) ────────────────────────────────────────────────────────

  /**
   * Issue a refund. Amounts > ₦50,000 (5,000,000 kobo) require a second
   * admin's approval (4-eyes principle) — the refund is recorded as
   * "awaiting_second_approval" and the provider call is deferred.
   */
  issueRefund: adminProcedure
    .input(z.object({
      walletId: z.number().int().positive(),
      transactionId: z.number().int().positive().optional(),
      amountKobo: z.number().int().positive().max(100_000_000),
      reason: z.string().min(10).max(500),
      /** Payment provider reference to refund against (required for provider refund) */
      paymentReference: z.string().min(1),
      provider: z.enum(["paystack", "flutterwave", "interswitch"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const FOUR_EYES_THRESHOLD_KOBO = 50_000 * 100; // ₦50,000
      const needsSecondApproval = input.amountKobo > FOUR_EYES_THRESHOLD_KOBO;
      const refundRef = `RFD-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

      const [row] = await db.insert(refunds).values({
        refundRef,
        walletId: input.walletId,
        transactionId: input.transactionId ?? null,
        amountKobo: input.amountKobo,
        reason: input.reason,
        status: needsSecondApproval ? "awaiting_second_approval" : "approved",
        requestedBy: ctx.user.id,
      }).returning({ id: refunds.id });

      void audit(ctx, "refund.issue", "refund", refundRef, {
        walletId: input.walletId,
        amountKobo: input.amountKobo,
        needsSecondApproval,
        reason: input.reason,
      });

      if (needsSecondApproval) {
        return {
          refundRef,
          status: "awaiting_second_approval" as const,
          message: "Refund over ₦50,000 recorded — a second admin must call approveRefund before it is processed.",
        };
      }

      // Below threshold: process immediately
      const result = await processRefund(refundRef, input.provider, input.paymentReference, input.amountKobo, ctx.user.id);
      return { refundRef, status: result.status, message: result.message };
    }),

  /**
   * Second-admin approval for large refunds (4-eyes). The approver must not
   * be the requester.
   */
  approveRefund: adminProcedure
    .input(z.object({
      refundRef: z.string().min(1),
      provider: z.enum(["paystack", "flutterwave", "interswitch"]),
      paymentReference: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [refund] = await db.select().from(refunds).where(eq(refunds.refundRef, input.refundRef)).limit(1);
      if (!refund) throw new TRPCError({ code: "NOT_FOUND", message: "Refund not found" });
      if (refund.status !== "awaiting_second_approval") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Refund is ${refund.status}, not awaiting approval` });
      }
      if (refund.requestedBy === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "4-eyes violation: the requester cannot approve their own refund" });
      }

      await db.update(refunds)
        .set({ status: "approved", approvedBy: ctx.user.id, updatedAt: new Date() })
        .where(eq(refunds.refundRef, input.refundRef));

      void audit(ctx, "refund.approve", "refund", input.refundRef, { requestedBy: refund.requestedBy });

      const result = await processRefund(input.refundRef, input.provider, input.paymentReference, refund.amountKobo, ctx.user.id);
      return { refundRef: input.refundRef, status: result.status, message: result.message };
    }),

  /** List refunds (most recent first). */
  listRefunds: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(refunds)
        .orderBy(desc(refunds.createdAt))
        .limit(input?.limit ?? 50);
    }),

  /**
   * Rich analytics aggregations for the AdminAnalytics dashboard.
   * Returns daily KYC outcomes (last N days), rejection reasons, app type breakdown,
   * wallet top-up totals, reconciliation stats, and per-state distribution.
   */
  getAnalytics: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { ...getDemoAnalytics(input.days), is_demo: true as const };

      try {
        const { walletTransactions } = await import("../../drizzle/schema");

        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - input.days);

        // ── Daily KYC outcomes ──────────────────────────────────────────────
        const dailyRaw = await db
          .select({
            date: sql<string>`DATE(${kycApplications.createdAt})`,
            status: kycApplications.status,
            count: count(),
          })
          .from(kycApplications)
          .where(gte(kycApplications.createdAt, startDate))
          .groupBy(sql`DATE(${kycApplications.createdAt})`, kycApplications.status);

        // Build a map of date → { approved, rejected, pending }
        const dailyMap: Record<string, { date: string; approved: number; rejected: number; pending: number; total: number }> = {};
        for (const row of dailyRaw) {
          if (!dailyMap[row.date]) {
            dailyMap[row.date] = { date: row.date, approved: 0, rejected: 0, pending: 0, total: 0 };
          }
          const n = Number(row.count);
          if (row.status === "approved") dailyMap[row.date].approved += n;
          else if (row.status === "rejected") dailyMap[row.date].rejected += n;
          else dailyMap[row.date].pending += n;
          dailyMap[row.date].total += n;
        }
        const dailyData = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

        // ── Rejection reasons (from reviewNotes JSONB field) ────────────────
        const rejectedApps = await db
          .select({ reviewNotes: kycApplications.reviewNotes })
          .from(kycApplications)
          .where(and(eq(kycApplications.status, "rejected"), gte(kycApplications.createdAt, startDate)));

        const reasonCounts: Record<string, number> = {};
        const REASON_KEYWORDS: Record<string, string> = {
          "address": "Address Mismatch",
          "blurry": "Blurry Document",
          "expired": "Expired ID",
          "nin": "NIN Mismatch",
          "liveness": "Liveness Fail",
          "bvn": "BVN Mismatch",
          "incomplete": "Incomplete Submission",
        };
        for (const app of rejectedApps) {
          const notes = (app.reviewNotes ?? "").toLowerCase();
          let matched = false;
          for (const [kw, label] of Object.entries(REASON_KEYWORDS)) {
            if (notes.includes(kw)) {
              reasonCounts[label] = (reasonCounts[label] ?? 0) + 1;
              matched = true;
              break;
            }
          }
          if (!matched) reasonCounts["Other"] = (reasonCounts["Other"] ?? 0) + 1;
        }
        const rejectionReasons = Object.entries(reasonCounts)
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 6);

        // ── Application type breakdown ──────────────────────────────────────
        const typeRaw = await db
          .select({ type: kycApplications.type, count: count() })
          .from(kycApplications)
          .where(gte(kycApplications.createdAt, startDate))
          .groupBy(kycApplications.type);
        const typeTotal = typeRaw.reduce((s, r) => s + Number(r.count), 0) || 1;
        const appTypeData = typeRaw.map(r => ({
          name: r.type === "driver" ? "Driver KYC" : r.type === "vehicle" ? "Vehicle Reg" : "Fleet KYB",
          value: Math.round((Number(r.count) / typeTotal) * 100),
          raw: Number(r.count),
        }));

        // ── KYC score histogram ─────────────────────────────────────────────
        const scoreRaw = await db
          .select({ kycScore: kycApplications.kycScore })
          .from(kycApplications)
          .where(and(gte(kycApplications.createdAt, startDate), sql`${kycApplications.kycScore} IS NOT NULL`));
        const scoreBuckets: Record<string, number> = {
          "0–20": 0, "21–40": 0, "41–60": 0, "61–70": 0,
          "71–80": 0, "81–90": 0, "91–100": 0,
        };
        for (const row of scoreRaw) {
          const s = row.kycScore ?? 0;
          if (s <= 20) scoreBuckets["0–20"]++;
          else if (s <= 40) scoreBuckets["21–40"]++;
          else if (s <= 60) scoreBuckets["41–60"]++;
          else if (s <= 70) scoreBuckets["61–70"]++;
          else if (s <= 80) scoreBuckets["71–80"]++;
          else if (s <= 90) scoreBuckets["81–90"]++;
          else scoreBuckets["91–100"]++;
        }
        const kycScoreHist = Object.entries(scoreBuckets).map(([range, count]) => ({ range, count }));

        // ── Wallet top-up totals ────────────────────────────────────────────
        const topupRaw = await db
          .select({ total: sql<number>`COALESCE(SUM(${walletTransactions.amountKobo}), 0)`, txCount: count() })
          .from(walletTransactions)
          .where(and(
            eq(walletTransactions.type, "topup"),
            gte(walletTransactions.createdAt, startDate)
          ));
        const topupTotalKobo = Number(topupRaw[0]?.total ?? 0);
        const topupCount = Number(topupRaw[0]?.txCount ?? 0);

        // ── Reconciliation stats ────────────────────────────────────────────
        const reconRaw = await db
          .select({
            totalRuns: count(),
            totalCredited: sql<number>`COALESCE(SUM(${reconciliationRuns.credited}), 0)`,
            totalFailed: sql<number>`COALESCE(SUM(${reconciliationRuns.failed}), 0)`,
          })
          .from(reconciliationRuns)
          .where(gte(reconciliationRuns.startedAt, startDate));

        // ── Summary KPIs ────────────────────────────────────────────────────
        const totalApps = dailyData.reduce((s, d) => s + d.total, 0);
        const totalApproved = dailyData.reduce((s, d) => s + d.approved, 0);
        const totalRejected = dailyData.reduce((s, d) => s + d.rejected, 0);
        const approvalRate = totalApproved + totalRejected > 0
          ? Math.round((totalApproved / (totalApproved + totalRejected)) * 100)
          : 0;

        return {
          dailyData,
          rejectionReasons,
          appTypeData,
          kycScoreHist,
          kpi: {
            totalApps,
            totalApproved,
            totalRejected,
            approvalRate,
            topupTotalKobo,
            topupCount,
            reconRuns: Number(reconRaw[0]?.totalRuns ?? 0),
            reconCredited: Number(reconRaw[0]?.totalCredited ?? 0),
            reconFailed: Number(reconRaw[0]?.totalFailed ?? 0),
          },
        };
      } catch (err) {
        console.warn("[Admin] getAnalytics DB error, returning demo data:", err);
        return { ...getDemoAnalytics(input.days), is_demo: true as const };
      }
    }),

  /**
   * Export analytics data as CSV.
   * Returns a CSV of daily KYC application counts for the last N days.
   */
  exportAnalyticsCsv: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        // Fall back to demo data for CSV export
        const demo = getDemoAnalytics(input.days);
        const header = "Date,Approved,Rejected,Pending,Total";
        const lines = demo.dailyData.map((d: { date: string; approved: number; rejected: number; pending: number }) =>
          `"${d.date}",${d.approved},${d.rejected},${d.pending},${d.approved + d.rejected + d.pending}`
        );
        return {
          csv: [header, ...lines].join("\n"),
          filename: `nigerianpass-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
          rowCount: lines.length,
          source: "demo" as const,
        };
      }

      try {
        const cutoff = new Date(Date.now() - input.days * 86_400_000);
        const rows = await db
          .select({
            date: sql<string>`date_trunc('day', ${kycApplications.createdAt})::date::text`,
            status: kycApplications.status,
            count: sql<number>`count(*)::int`,
          })
          .from(kycApplications)
          .where(gte(kycApplications.createdAt, cutoff))
          .groupBy(sql`date_trunc('day', ${kycApplications.createdAt})`, kycApplications.status)
          .orderBy(sql`date_trunc('day', ${kycApplications.createdAt})`);

        // Pivot by date
        const byDate: Record<string, { approved: number; rejected: number; pending: number }> = {};
        for (const row of rows) {
          if (!byDate[row.date]) byDate[row.date] = { approved: 0, rejected: 0, pending: 0 };
          if (row.status === "approved") byDate[row.date].approved += row.count;
          else if (row.status === "rejected") byDate[row.date].rejected += row.count;
          else byDate[row.date].pending += row.count;
        }

        const header = "Date,Approved,Rejected,Pending,Total";
        const lines = Object.entries(byDate).map(([date, d]) =>
          `"${date}",${d.approved},${d.rejected},${d.pending},${d.approved + d.rejected + d.pending}`
        );

        return {
          csv: [header, ...lines].join("\n"),
          filename: `nigerianpass-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
          rowCount: lines.length,
          source: "live" as const,
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to export analytics: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Mark a reconciliation run alert as resolved.
   * Accepts an optional admin note explaining the investigation outcome.
   */
  resolveAlert: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const updated = await resolveReconciliationRun(input.id, input.note);
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Reconciliation run #${input.id} not found`,
        });
      }
      console.log(
        `[Admin] Run #${input.id} marked resolved by user ${ctx.user.id}` +
        (input.note ? ` — note: ${input.note}` : "")
      );
      return {
        id: updated.id,
        resolvedAt: updated.resolvedAt?.toISOString() ?? null,
        resolvedNote: updated.resolvedNote,
      };
    }),
});

// ── Demo stats (used when DB is unavailable) ──────────────────────────────────────────────
function getDemoStats() {
  return {
    total: 247,
    pending: 38,
    approved: 189,
    rejected: 14,
    requiresResubmission: 6,
    approvalRate: 77,
    byType: { driver: 142, vehicle: 73, fleet: 32 },
    recentActivity: [],
  };
}

// ── Demo analytics (used when DB is unavailable) ─────────────────────────────────────────
function getDemoAnalytics(days: number) {
  const dailyData = Array.from({ length: Math.min(days, 14) }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const approved = Math.floor(Math.random() * 12) + 3;
    const rejected = Math.floor(Math.random() * 4);
    const pending = Math.floor(Math.random() * 8) + 1;
    return {
      date: d.toISOString().split("T")[0],
      approved,
      rejected,
      pending,
      total: approved + rejected + pending,
    };
  });
  return {
    dailyData,
    rejectionReasons: [
      { name: "NIN Mismatch", value: 8 },
      { name: "Blurry Document", value: 5 },
      { name: "Expired ID", value: 4 },
      { name: "Address Mismatch", value: 3 },
      { name: "Liveness Fail", value: 2 },
      { name: "Other", value: 2 },
    ],
    appTypeData: [
      { name: "Driver KYC", value: 57, raw: 142 },
      { name: "Vehicle Reg", value: 29, raw: 73 },
      { name: "Fleet KYB", value: 14, raw: 32 },
    ],
    kycScoreHist: [
      { range: "0–20", count: 3 },
      { range: "21–40", count: 8 },
      { range: "41–60", count: 22 },
      { range: "61–70", count: 38 },
      { range: "71–80", count: 54 },
      { range: "81–90", count: 71 },
      { range: "91–100", count: 51 },
    ],
    kpi: {
      totalApps: 247,
      totalApproved: 189,
      totalRejected: 14,
      approvalRate: 77,
      topupTotalKobo: 45_000_000,
      topupCount: 312,
      reconRuns: 28,
      reconCredited: 298,
      reconFailed: 4,
    },
  };
}

// ── Refund processing helper (P1-19) ──────────────────────────────────────────
/**
 * Execute an approved refund: call the provider refund API, then post an
 * atomic ledger reversal (refund entry + conditional balance decrement) in a
 * single DB transaction. Failures mark the refund row "failed" — no partial
 * state is committed.
 */
async function processRefund(
  refundRef: string,
  provider: "paystack" | "flutterwave" | "interswitch",
  paymentReference: string,
  amountKobo: number,
  adminUserId: number,
): Promise<{ status: "processed" | "failed"; message: string }> {
  const db = await getDb();
  if (!db) return { status: "failed", message: "Database unavailable" };

  // 1. Provider-side refund
  const { requestProviderRefund } = await import("../payments/gateway");
  let providerRef: string;
  try {
    const r = await requestProviderRefund(provider, paymentReference, amountKobo);
    providerRef = r.providerRef;
  } catch (err) {
    await db.update(refunds)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(refunds.refundRef, refundRef));
    console.error(`[Refunds] Provider refund failed for ${refundRef}:`, err);
    return { status: "failed", message: `Provider refund failed: ${(err as Error).message}` };
  }

  // 2. Ledger reversal — atomic, guarded against negative balance
  try {
    const { walletAccounts, walletTransactions } = await import("../../drizzle/schema");
    const [refund] = await db.select().from(refunds).where(eq(refunds.refundRef, refundRef)).limit(1);
    if (!refund) throw new Error("Refund row disappeared");

    await db.transaction(async (tx) => {
      const upd = await tx
        .update(walletAccounts)
        .set({
          balanceKobo: sql`${walletAccounts.balanceKobo} - ${amountKobo}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(walletAccounts.id, refund.walletId),
          sql`${walletAccounts.balanceKobo} >= ${amountKobo}`,
        ))
        .returning({ balanceKobo: walletAccounts.balanceKobo });

      if (upd.length === 0) {
        throw new Error("Insufficient wallet balance for ledger reversal");
      }

      await tx.insert(walletTransactions).values({
        walletId: refund.walletId,
        type: "refund",
        amountKobo: -amountKobo,
        balanceAfterKobo: upd[0]!.balanceKobo,
        externalRef: refundRef,
        description: `Refund ${refundRef} (provider ref ${providerRef})`,
      });
    });

    await db.update(refunds)
      .set({ status: "processed", providerRef, updatedAt: new Date() })
      .where(eq(refunds.refundRef, refundRef));

    console.log(`[Refunds] ${refundRef} processed by admin ${adminUserId}: ${providerRef}`);
    return { status: "processed", message: `Refund processed (${providerRef})` };
  } catch (err) {
    await db.update(refunds)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(refunds.refundRef, refundRef));
    console.error(`[Refunds] Ledger reversal failed for ${refundRef}:`, err);
    return { status: "failed", message: `Ledger reversal failed: ${(err as Error).message}` };
  }
}
