/**
 * eTag / RFID Tag Lifecycle tRPC Router
 * =====================================
 * Manages the full lifecycle of RFID windshield tags / eTags / NFC cards:
 *
 *   issue → activate → (suspend / reportLost / replace / decommission)
 *
 * Procedures:
 *  - etag.issue        (operator)  — register a new tag (EPC-96), status 'issued'
 *  - etag.activate     (owner/operator) — issued → active, sets activatedAt
 *  - etag.suspend      (operator/admin)
 *  - etag.reportLost   (owner of linked wallet OR operator/admin)
 *  - etag.decommission (operator/admin)
 *  - etag.replace      (operator/admin) — atomic swap, old → 'replaced'
 *  - etag.linkWallet   (owner/operator) — bind a tag to a wallet
 *  - etag.myTags       (authenticated) — tags bound to the caller's wallet
 *  - etag.getByPlate / etag.getByEpc (operator/admin/reviewer)
 *  - etag.list         (operator/admin) — paginated, filter + search
 *
 * All mutations write to the append-only audit log via audit(ctx, ...).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  operatorProcedure,
  protectedProcedure,
  router,
} from "../_core/trpc";
import { getDb } from "../db";
import { rfidTags, walletAccounts } from "../../drizzle/schema";
import type { RfidTag } from "../../drizzle/schema";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { audit } from "../_core/audit";
import type { TrpcContext } from "../_core/context";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** EPC-96: 24 uppercase hex characters. */
export const EPC96_REGEX = /^[0-9A-F]{24}$/;

const epcSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => EPC96_REGEX.test(v), {
    message: "tagEpc must be a 24-character uppercase hex EPC-96 identifier",
  });

const OPERATOR_ROLES = ["admin", "operator", "installer"];
const REVIEW_ROLES = [...OPERATOR_ROLES, "reviewer"];

function isOperator(ctx: Pick<TrpcContext, "user">): boolean {
  return !!ctx.user && OPERATOR_ROLES.includes(ctx.user.role);
}

/** Role gate for operator/admin/reviewer read endpoints. */
function assertReviewRole(ctx: Pick<TrpcContext, "user">): void {
  if (!ctx.user || !REVIEW_ROLES.includes(ctx.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient role" });
  }
}

function requireDb(db: Awaited<ReturnType<typeof getDb>>) {
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  }
  return db;
}

async function getTagByEpc(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tagEpc: string) {
  const rows = await db.select().from(rfidTags).where(eq(rfidTags.tagEpc, tagEpc)).limit(1);
  return rows[0];
}

/** True when the caller owns the wallet the tag is linked to. */
async function callerOwnsTag(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ctx: Pick<TrpcContext, "user">,
  tag: RfidTag,
): Promise<boolean> {
  if (!ctx.user || tag.walletId == null) return false;
  const rows = await db
    .select({ userId: walletAccounts.userId })
    .from(walletAccounts)
    .where(eq(walletAccounts.id, tag.walletId))
    .limit(1);
  return rows[0]?.userId === ctx.user.id;
}

/** Throws FORBIDDEN unless the caller is operator/admin or owns the tag's wallet. */
async function assertOwnerOrOperator(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ctx: Pick<TrpcContext, "user">,
  tag: RfidTag,
): Promise<void> {
  if (isOperator(ctx)) return;
  if (await callerOwnsTag(db, ctx, tag)) return;
  throw new TRPCError({ code: "FORBIDDEN", message: "Not the tag owner" });
}

/** Detect a Postgres unique-violation (23505) from drizzle/pg errors. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// ── Router ────────────────────────────────────────────────────────────────────

export const etagRouter = router({
  /**
   * Issue a new tag. Operator-only. Conflict on duplicate EPC.
   */
  issue: operatorProcedure
    .input(z.object({
      tagEpc: epcSchema,
      tagType: z.enum(["rfid_windshield", "etag", "nfc_card"]),
      vehiclePlate: z.string().trim().min(2).max(16).optional(),
      walletId: z.number().int().positive().optional(),
      kycApplicationId: z.number().int().positive().optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());

      if (input.walletId != null) {
        const [wallet] = await db
          .select({ id: walletAccounts.id })
          .from(walletAccounts)
          .where(eq(walletAccounts.id, input.walletId))
          .limit(1);
        if (!wallet) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Wallet ${input.walletId} not found` });
        }
      }

      try {
        const [tag] = await db
          .insert(rfidTags)
          .values({
            tagEpc: input.tagEpc,
            tagType: input.tagType,
            vehiclePlate: input.vehiclePlate ?? null,
            kycApplicationId: input.kycApplicationId ?? null,
            walletId: input.walletId ?? null,
            status: "issued",
            issuedBy: ctx.user.id,
            meta: input.meta ?? null,
          })
          .returning();

        void audit(ctx, "etag.issue", "rfid_tag", input.tagEpc, {
          tagId: tag!.id,
          tagType: input.tagType,
          vehiclePlate: input.vehiclePlate ?? null,
          walletId: input.walletId ?? null,
        });

        return tag!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Tag ${input.tagEpc} is already registered`,
          });
        }
        throw err;
      }
    }),

  /**
   * Activate an issued tag (owner of the linked wallet OR operator/admin).
   */
  activate: protectedProcedure
    .input(z.object({ tagEpc: epcSchema }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());
      const tag = await getTagByEpc(db, input.tagEpc);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      await assertOwnerOrOperator(db, ctx, tag);
      if (tag.status !== "issued") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Tag cannot be activated from status '${tag.status}'`,
        });
      }

      const [updated] = await db
        .update(rfidTags)
        .set({ status: "active", activatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(rfidTags.id, tag.id), eq(rfidTags.status, "issued")))
        .returning();

      void audit(ctx, "etag.activate", "rfid_tag", tag.tagEpc, {
        from: "issued",
        to: "active",
        tagId: tag.id,
      });

      return updated ?? { ...tag, status: "active" as const };
    }),

  /**
   * Suspend a tag (operator/admin). Blocked from lane charging while suspended.
   */
  suspend: operatorProcedure
    .input(z.object({ tagEpc: epcSchema, reason: z.string().max(256).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());
      const tag = await getTagByEpc(db, input.tagEpc);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      if (["replaced", "decommissioned"].includes(tag.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Tag is terminally '${tag.status}' and cannot be suspended`,
        });
      }

      const [updated] = await db
        .update(rfidTags)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(rfidTags.id, tag.id))
        .returning();

      void audit(ctx, "etag.suspend", "rfid_tag", tag.tagEpc, {
        from: tag.status,
        to: "suspended",
        reason: input.reason ?? null,
      });

      return updated!;
    }),

  /**
   * Report a tag lost (owner of the linked wallet OR operator/admin).
   * A lost tag is permanently unusable — issue a replacement instead.
   */
  reportLost: protectedProcedure
    .input(z.object({ tagEpc: epcSchema, note: z.string().max(256).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());
      const tag = await getTagByEpc(db, input.tagEpc);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      await assertOwnerOrOperator(db, ctx, tag);
      if (["lost", "replaced", "decommissioned"].includes(tag.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Tag is already '${tag.status}'`,
        });
      }

      const [updated] = await db
        .update(rfidTags)
        .set({ status: "lost", updatedAt: new Date() })
        .where(eq(rfidTags.id, tag.id))
        .returning();

      void audit(ctx, "etag.reportLost", "rfid_tag", tag.tagEpc, {
        from: tag.status,
        to: "lost",
        note: input.note ?? null,
      });

      return updated!;
    }),

  /**
   * Decommission a tag (operator/admin) — terminal state for retired hardware.
   */
  decommission: operatorProcedure
    .input(z.object({ tagEpc: epcSchema, reason: z.string().max(256).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());
      const tag = await getTagByEpc(db, input.tagEpc);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });

      const [updated] = await db
        .update(rfidTags)
        .set({ status: "decommissioned", updatedAt: new Date() })
        .where(eq(rfidTags.id, tag.id))
        .returning();

      void audit(ctx, "etag.decommission", "rfid_tag", tag.tagEpc, {
        from: tag.status,
        to: "decommissioned",
        reason: input.reason ?? null,
      });

      return updated!;
    }),

  /**
   * Replace a tag (operator/admin) in a single DB transaction:
   * the old tag goes to 'replaced' (with replacedByTagId) and the new EPC is
   * registered as a fresh 'active' tag carrying over walletId + vehiclePlate.
   */
  replace: operatorProcedure
    .input(z.object({
      oldTagEpc: epcSchema,
      newTagEpc: epcSchema,
      tagType: z.enum(["rfid_windshield", "etag", "nfc_card"]).optional(),
      reason: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());
      if (input.oldTagEpc === input.newTagEpc) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Replacement EPC must differ from the old EPC" });
      }

      const oldTag = await getTagByEpc(db, input.oldTagEpc);
      if (!oldTag) throw new TRPCError({ code: "NOT_FOUND", message: "Old tag not found" });
      if (["replaced", "decommissioned"].includes(oldTag.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Tag is terminally '${oldTag.status}' and cannot be replaced`,
        });
      }

      try {
        const result = await db.transaction(async (tx) => {
          const [newTag] = await tx
            .insert(rfidTags)
            .values({
              tagEpc: input.newTagEpc,
              tagType: input.tagType ?? oldTag.tagType,
              vehiclePlate: oldTag.vehiclePlate,
              kycApplicationId: oldTag.kycApplicationId,
              walletId: oldTag.walletId,
              status: "active",
              issuedBy: ctx.user.id,
              activatedAt: new Date(),
              meta: { ...(oldTag.meta ?? {}), replacedFrom: oldTag.tagEpc },
            })
            .returning();

          const [retired] = await tx
            .update(rfidTags)
            .set({ status: "replaced", replacedByTagId: newTag!.id, updatedAt: new Date() })
            .where(eq(rfidTags.id, oldTag.id))
            .returning();

          return { oldTag: retired!, newTag: newTag! };
        });

        void audit(ctx, "etag.replace", "rfid_tag", input.oldTagEpc, {
          oldTagId: result.oldTag.id,
          newTagId: result.newTag.id,
          newTagEpc: input.newTagEpc,
          reason: input.reason ?? null,
        });

        return result;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Tag ${input.newTagEpc} is already registered`,
          });
        }
        throw err;
      }
    }),

  /**
   * Link (or re-link) a tag to a wallet. Caller must own the target wallet
   * or be operator/admin; a non-operator may only move tags already bound
   * to their own wallet (or unbound tags they activate).
   */
  linkWallet: protectedProcedure
    .input(z.object({
      tagEpc: epcSchema,
      walletId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb(await getDb());
      const tag = await getTagByEpc(db, input.tagEpc);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      if (["lost", "replaced", "decommissioned"].includes(tag.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Tag is '${tag.status}' and cannot be linked`,
        });
      }

      const [wallet] = await db
        .select()
        .from(walletAccounts)
        .where(eq(walletAccounts.id, input.walletId))
        .limit(1);
      if (!wallet) throw new TRPCError({ code: "BAD_REQUEST", message: "Wallet not found" });

      if (!isOperator(ctx)) {
        const ownsTarget = wallet.userId === ctx.user.id;
        const ownsCurrent = await callerOwnsTag(db, ctx, tag);
        if (!ownsTarget || (tag.walletId != null && !ownsCurrent)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not authorised to link this tag" });
        }
      }

      const [updated] = await db
        .update(rfidTags)
        .set({ walletId: input.walletId, updatedAt: new Date() })
        .where(eq(rfidTags.id, tag.id))
        .returning();

      void audit(ctx, "etag.linkWallet", "rfid_tag", tag.tagEpc, {
        fromWalletId: tag.walletId,
        toWalletId: input.walletId,
      });

      return updated!;
    }),

  /**
   * Tags linked to the caller's own wallet.
   */
  myTags: protectedProcedure.query(async ({ ctx }) => {
    const db = requireDb(await getDb());
    const [wallet] = await db
      .select({ id: walletAccounts.id })
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, ctx.user.id))
      .limit(1);
    if (!wallet) return [];
    return db
      .select()
      .from(rfidTags)
      .where(eq(rfidTags.walletId, wallet.id))
      .orderBy(desc(rfidTags.createdAt));
  }),

  /**
   * Lookup a tag by EPC (operator/admin/reviewer).
   */
  getByEpc: protectedProcedure
    .input(z.object({ tagEpc: epcSchema }))
    .query(async ({ ctx, input }) => {
      assertReviewRole(ctx);
      const db = requireDb(await getDb());
      const tag = await getTagByEpc(db, input.tagEpc);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      return tag;
    }),

  /**
   * Lookup tags by vehicle plate (operator/admin/reviewer).
   */
  getByPlate: protectedProcedure
    .input(z.object({ vehiclePlate: z.string().trim().min(2).max(16) }))
    .query(async ({ ctx, input }) => {
      assertReviewRole(ctx);
      const db = requireDb(await getDb());
      return db
        .select()
        .from(rfidTags)
        .where(ilike(rfidTags.vehiclePlate, input.vehiclePlate))
        .orderBy(desc(rfidTags.createdAt))
        .limit(50);
    }),

  /**
   * Paginated tag registry (operator/admin). Filter by status or by issuing
   * plaza (stored in meta->>'plazaId'); free-text search over plate and EPC.
   */
  list: operatorProcedure
    .input(z.object({
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(50),
      status: z.enum(["issued", "active", "suspended", "lost", "replaced", "decommissioned"]).optional(),
      plazaId: z.string().trim().max(64).optional(),
      search: z.string().trim().max(64).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = requireDb(await getDb());

      const conditions = [];
      if (input.status) conditions.push(eq(rfidTags.status, input.status));
      if (input.plazaId) {
        conditions.push(sql`${rfidTags.meta} ->> 'plazaId' = ${input.plazaId}`);
      }
      if (input.search) {
        conditions.push(or(
          ilike(rfidTags.vehiclePlate, `%${input.search}%`),
          ilike(rfidTags.tagEpc, `%${input.search.toUpperCase()}%`),
        ));
      }
      const whereClause = conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

      const offset = (input.page - 1) * input.limit;
      const [rows, countRows] = await Promise.all([
        db.select().from(rfidTags)
          .where(whereClause)
          .orderBy(desc(rfidTags.createdAt))
          .limit(input.limit)
          .offset(offset),
        db.select({ total: sql<number>`count(*)::int` })
          .from(rfidTags)
          .where(whereClause),
      ]);

      return {
        tags: rows,
        total: countRows[0]?.total ?? 0,
        page: input.page,
        limit: input.limit,
      };
    }),
});
