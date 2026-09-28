/**
 * NDPR Data Rights Router (P1-20)
 * ================================
 * Nigerian Data Protection Regulation compliance endpoints:
 *  - exportMyData    — full personal data export (profile, KYC, wallet meta)
 *  - requestErasure  — pseudonymise PII; financial ledger rows are retained
 *                      (legal obligation) with user references anonymised
 *  - recordConsent   — consent registry (consents table)
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  users,
  kycApplications,
  walletAccounts,
  walletTransactions,
  consents,
  sessions,
} from "../../drizzle/schema";
import { audit } from "../_core/audit";

export const dataRightsRouter = router({
  /**
   * Export all personal data held about the current user as a JSON document
   * (NDPR right of access / data portability).
   */
  exportMyData: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    const [user] = await db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1);
    const applications = await db.select().from(kycApplications).where(eq(kycApplications.userId, ctx.user.id));
    const wallets = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, ctx.user.id));
    const consentRows = await db.select().from(consents).where(eq(consents.userId, ctx.user.id));

    let transactions: unknown[] = [];
    if (wallets[0]) {
      transactions = await db.select().from(walletTransactions).where(eq(walletTransactions.walletId, wallets[0].id));
    }

    void audit(ctx, "data.export", "user", ctx.user.id, {
      applications: applications.length,
      transactions: transactions.length,
    });

    return {
      exportedAt: new Date().toISOString(),
      profile: {
        id: user?.id,
        name: user?.name,
        email: user?.email,
        loginMethod: user?.loginMethod,
        role: user?.role,
        createdAt: user?.createdAt,
        lastSignedIn: user?.lastSignedIn,
      },
      kycApplications: applications.map(a => ({
        referenceId: a.referenceId,
        type: a.type,
        status: a.status,
        formData: a.formData,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      wallet: wallets[0]
        ? {
            balanceKobo: wallets[0].balanceKobo,
            dailyCapKobo: wallets[0].dailyCapKobo,
            createdAt: wallets[0].createdAt,
          }
        : null,
      transactions,
      consents: consentRows,
    };
  }),

  /**
   * Request erasure (NDPR right to be forgotten).
   * PII on the user record is pseudonymised. The financial ledger
   * (wallet_accounts, wallet_transactions) is RETAINED for the statutory
   * period but the user linkage is anonymised; active sessions are revoked.
   */
  requestErasure: protectedProcedure
    .input(z.object({
      /** Explicit confirmation phrase */
      confirmation: z.literal("DELETE MY DATA"),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      void input.reason;
      const pseudonym = `erased-${ctx.user.id}-${Date.now().toString(36)}`;

      await db.transaction(async (tx) => {
        // Pseudonymise the user record
        await tx.update(users).set({
          name: "[erased]",
          email: `${pseudonym}@erased.invalid`,
          openId: `erased:${pseudonym}`,
        }).where(eq(users.id, ctx.user.id));

        // Pseudonymise PII inside KYC applications (keep type/status/reference
        // for audit; wipe the personal form payload)
        await tx.update(kycApplications).set({
          formData: sql`'{"erased": true}'::jsonb`,
        }).where(eq(kycApplications.userId, ctx.user.id));

        // Revoke all sessions
        await tx.update(sessions).set({ revokedAt: new Date() })
          .where(eq(sessions.userId, ctx.user.id));
      });

      void audit(ctx, "data.erasure", "user", ctx.user.id, { pseudonym });

      return {
        success: true as const,
        message: "Personal data has been pseudonymised. Financial ledger records are retained per statutory requirements but are no longer linked to your identity.",
      };
    }),

  /**
   * Record (or withdraw) a consent (NDPR consent management).
   */
  recordConsent: protectedProcedure
    .input(z.object({
      type: z.enum(["terms_of_service", "privacy_policy", "marketing", "data_processing", "location_tracking"]),
      version: z.string().min(1).max(32),
      granted: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const ip =
        (ctx.req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        ctx.req.socket?.remoteAddress ??
        null;

      await db.insert(consents).values({
        userId: ctx.user.id,
        type: input.type,
        version: input.version,
        granted: input.granted,
        ip,
      });

      void audit(ctx, input.granted ? "consent.grant" : "consent.withdraw", "consent", input.type, {
        version: input.version,
      });

      return { success: true as const };
    }),

  /** List the current user's consent records. */
  myConsents: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(consents).where(eq(consents.userId, ctx.user.id));
  }),
});
