/**
 * Audit Trail Helper
 * ==================
 * append-only writes to the audit_logs table for security-relevant actions.
 * Fire-and-forget by design: audit failures are logged but never break the
 * primary operation. Money-moving and admin mutation paths should call this.
 */
import { getDb } from "../db";
import { auditLogs } from "../../drizzle/schema";
import type { TrpcContext } from "./context";

export interface AuditEntry {
  actorUserId: number | null;
  actorRole?: string | null;
  action: string;
  entity: string;
  entityId: string;
  diff?: Record<string, unknown>;
}

/** Low-level writer — usable outside tRPC contexts (webhooks, jobs). */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(auditLogs).values({
      actorUserId: entry.actorUserId,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      diff: entry.diff ?? null,
    });
  } catch (err) {
    console.warn(`[Audit] Failed to write audit log (${entry.action} on ${entry.entity}:${entry.entityId}):`, err);
  }
}

/**
 * tRPC-context convenience wrapper:
 *   await audit(ctx, "kyc.approve", "kyc_application", refId, { from, to });
 */
export async function audit(
  ctx: Pick<TrpcContext, "user">,
  action: string,
  entity: string,
  entityId: string | number,
  diff?: Record<string, unknown>,
): Promise<void> {
  await writeAuditLog({
    actorUserId: ctx.user?.id ?? null,
    actorRole: ctx.user?.role ?? null,
    action,
    entity,
    entityId: String(entityId),
    diff,
  });
}
