/**
 * Permify integration — relationship-based access control (ReBAC).
 *
 * WHY: global roles (admin/operator/reviewer) are handled by Keycloak/JWT.
 * Permify answers the questions roles can't: "is THIS fleet manager allowed to
 * revoke THIS device?" — edges like fleet→drivers and plaza→devices.
 * Schema model lives in infra/permify/schema.perm.
 *
 * ENABLE WHEN: multi-tenant constructs ship (fleets managing their own
 * drivers/devices, plaza operators with scoped access). Before that, a roles
 * check in tRPC middleware is enough.
 *
 * Env: PERMIFY_URL (REST, e.g. http://localhost:3476), PERMIFY_TENANT_ID
 * (default "t1"). Compose profile: `extended`.
 */

import { DISABLED_HEALTH, logOnce, parseEnvOrNull, withRetry, z, type IntegrationHealth } from "./_common";

const envSchema = z.object({
  PERMIFY_URL: z.string().min(1),
  PERMIFY_TENANT_ID: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

let _env: Env | null | undefined;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Permify");
  return _env;
}

export function permifyEnabled(): boolean {
  return env() !== null;
}

/** Canonical ReBAC schema (mirrors infra/permify/schema.perm). */
export const PERMIFY_SCHEMA = `
entity user {}

entity organization {
    relation admin @user
    relation member @user
    action manage = admin
    action view = admin or member
}

entity device {
    relation parent @organization
    action view = parent.admin or parent.member
    action provision = parent.admin
    action revoke = parent.admin
}

entity application {
    relation parent @organization
    relation assignee @user
    action review = assignee or parent.admin
    action view = assignee or parent.member
}

entity wallet {
    relation owner @user
    relation parent @organization
    action debit = owner or parent.admin
    action view = owner or parent.member
}
`;

type PermifyAction = "manage" | "view" | "provision" | "revoke" | "review" | "debit";
type PermifyEntityType = "organization" | "device" | "application" | "wallet";

async function permifyFetch(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const e = env();
  if (!e) return null;
  const base = e.PERMIFY_URL.replace(/\/$/, "");
  const tenant = e.PERMIFY_TENANT_ID ?? "t1";
  const res = await fetch(`${base}/v1/tenants/${tenant}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`permify ${path} HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Authorization check. FAIL-CLOSED on Permify outage for privileged actions:
 * returns false and logs once — a degraded authz service must deny, not allow.
 */
export async function checkAccess(
  user: string | number,
  action: PermifyAction,
  resource: { type: PermifyEntityType; id: string | number },
): Promise<boolean> {
  if (!permifyEnabled()) return false;
  try {
    const result = await withRetry(
      () =>
        permifyFetch("/permissions/check", {
          metadata: { schema_version: "", depth: 20 },
          entity: { type: resource.type, id: String(resource.id) },
          permission: action,
          subject: { type: "user", id: String(user) },
        }),
      { label: "permify-check", attempts: 2, baseDelayMs: 150 },
    );
    return (result as { can?: string } | null)?.can === "RESULT_ALLOWED";
  } catch (err) {
    logOnce("permify:check", "warn", `[Permify] check failed closed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Low-level relation write. */
export async function writeRelation(
  entity: { type: PermifyEntityType; id: string | number },
  relation: "admin" | "member" | "parent" | "assignee" | "owner",
  subject: { type: "user" | PermifyEntityType; id: string | number },
): Promise<boolean> {
  if (!permifyEnabled()) return false;
  try {
    await permifyFetch("/data/relationships/write", {
      metadata: { schema_version: "" },
      tuples: [
        {
          entity: { type: entity.type, id: String(entity.id) },
          relation,
          subject: { type: subject.type, id: String(subject.id) },
        },
      ],
    });
    return true;
  } catch (err) {
    logOnce("permify:write", "error", `[Permify] relation write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** fleet→driver: user becomes a member of a fleet organization. */
export async function addDriverToFleet(driverUserId: string | number, fleetOrgId: string | number): Promise<boolean> {
  return writeRelation({ type: "organization", id: fleetOrgId }, "member", { type: "user", id: driverUserId });
}

/** fleet→admin: user administers a fleet organization. */
export async function addFleetAdmin(userId: string | number, fleetOrgId: string | number): Promise<boolean> {
  return writeRelation({ type: "organization", id: fleetOrgId }, "admin", { type: "user", id: userId });
}

/** plaza→device: device belongs to a plaza organization. */
export async function assignDeviceToPlaza(deviceId: string | number, plazaOrgId: string | number): Promise<boolean> {
  return writeRelation({ type: "device", id: deviceId }, "parent", { type: "organization", id: plazaOrgId });
}

/** fleet→device: device belongs to a fleet organization. */
export async function assignDeviceToFleet(deviceId: string | number, fleetOrgId: string | number): Promise<boolean> {
  return writeRelation({ type: "device", id: deviceId }, "parent", { type: "organization", id: fleetOrgId });
}

/** KYC application → reviewer assignment. */
export async function assignApplicationReviewer(applicationId: string | number, reviewerUserId: string | number): Promise<boolean> {
  return writeRelation({ type: "application", id: applicationId }, "assignee", { type: "user", id: reviewerUserId });
}

/** Push the schema (idempotent; returns the schema version when enabled). */
export async function writeSchema(): Promise<string | null> {
  if (!permifyEnabled()) return null;
  try {
    const result = await permifyFetch("/schemas/write", { schema: PERMIFY_SCHEMA });
    return (result as { schema_version?: string } | null)?.schema_version ?? null;
  } catch (err) {
    logOnce("permify:schema", "error", `[Permify] schema write failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function permifyHealth(): Promise<IntegrationHealth> {
  if (!permifyEnabled()) return DISABLED_HEALTH;
  const e = env();
  const started = Date.now();
  try {
    const res = await fetch(`${e!.PERMIFY_URL.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(3000) });
    return { enabled: true, ok: res.ok, latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
