/**
 * APISIX integration — declarative route/upstream sync via the Admin API.
 *
 * ENABLE WHEN: traffic needs edge concerns outside the Node process —
 * centralized rate limiting across replicas, WAF (openappsec plugin), OIDC at
 * the edge, or canary upstreams. In dev, Express handles everything; APISIX is
 * compose profile `edge` and sits in front of the app only in production.
 *
 * Source of truth: infra/apisix-routes.json (routes, upstreams, plugin config
 * including the openappsec attachment). This module diffs and applies it via
 * the Admin API. In standalone mode the same manifest is rendered into
 * infra/apisix/apisix-standalone.yaml — keep the two in sync.
 *
 * Env: APISIX_ADMIN_URL (e.g. http://localhost:9180), APISIX_ADMIN_KEY.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { DISABLED_HEALTH, logOnce, parseEnvOrNull, withRetry, z, type IntegrationHealth } from "./_common";

const envSchema = z.object({
  APISIX_ADMIN_URL: z.string().min(1),
  APISIX_ADMIN_KEY: z.string().min(1),
  APISIX_ROUTES_FILE: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

const routeSchema = z.object({
  id: z.string().min(1),
  uris: z.array(z.string()).min(1),
  upstream_id: z.string().min(1),
  priority: z.number().optional(),
  enable: z.boolean().optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
});

const manifestSchema = z.object({
  upstreams: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().default("roundrobin"),
        nodes: z.array(z.object({ host: z.string(), port: z.number(), weight: z.number() })),
        retries: z.number().optional(),
        timeout: z.record(z.string(), z.number()).optional(),
        checks: z.unknown().optional(),
      }),
    )
    .default([]),
  routes: z.array(routeSchema).default([]),
});

export type ApisixRouteManifest = z.output<typeof manifestSchema>;

let _env: Env | null | undefined;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Apisix");
  return _env;
}

export function apisixEnabled(): boolean {
  return env() !== null;
}

/** Default manifest path, overridable via APISIX_ROUTES_FILE. */
function manifestPath(): string {
  return env()?.APISIX_ROUTES_FILE ?? path.resolve(process.cwd(), "infra/apisix-routes.json");
}

/** Load + validate the declarative manifest. Throws on invalid JSON/schema. */
export async function loadRouteManifest(file?: string): Promise<ApisixRouteManifest> {
  const raw = await readFile(file ?? manifestPath(), "utf8");
  return manifestSchema.parse(JSON.parse(raw));
}

async function adminRequest(method: string, resource: string, id?: string, body?: unknown): Promise<Record<string, unknown> | null> {
  const e = env();
  if (!e) return null;
  const base = e.APISIX_ADMIN_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/apisix/admin/${resource}${id ? `/${id}` : ""}`, {
    method,
    headers: { "X-API-KEY": e.APISIX_ADMIN_KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) throw new Error(`apisix admin ${method} ${resource}/${id ?? ""} HTTP ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export interface SyncReport {
  applied: string[];
  skippedDisabled: string[];
  failed: Array<{ id: string; error: string }>;
  enabled: boolean;
}

/**
 * Apply the manifest to APISIX. Disabled routes (`enable: false`) are skipped
 * with a note — e.g. backoffice-sso stays off until Keycloak is live.
 * Secrets in the manifest use "${ENV_VAR}" placeholders substituted here.
 */
export async function syncApisixRoutes(file?: string): Promise<SyncReport> {
  const report: SyncReport = { applied: [], skippedDisabled: [], failed: [], enabled: apisixEnabled() };
  if (!apisixEnabled()) {
    logOnce("apisix:off", "info", "[Apisix] sync skipped — APISIX_ADMIN_URL/APISIX_ADMIN_KEY unset (direct Express serving)");
    return report;
  }
  let manifest: ApisixRouteManifest;
  try {
    manifest = await loadRouteManifest(file);
  } catch (err) {
    report.failed.push({ id: "<manifest>", error: err instanceof Error ? err.message : String(err) });
    return report;
  }

  const hydrate = (value: unknown): unknown => {
    if (typeof value === "string") {
      const m = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
      if (m) return process.env[m[1]] ?? value;
      return value;
    }
    if (Array.isArray(value)) return value.map(hydrate);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hydrate(v)]));
    return value;
  };

  for (const upstream of manifest.upstreams) {
    try {
      await withRetry(() => adminRequest("PUT", "upstreams", upstream.id, hydrate(upstream)), { label: `apisix-upstream-${upstream.id}`, attempts: 2 });
      report.applied.push(`upstream:${upstream.id}`);
    } catch (err) {
      report.failed.push({ id: `upstream:${upstream.id}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const route of manifest.routes) {
    const { enable, ...rest } = route;
    if (enable === false) {
      report.skippedDisabled.push(route.id);
      continue;
    }
    try {
      await withRetry(() => adminRequest("PUT", "routes", route.id, hydrate(rest)), { label: `apisix-route-${route.id}`, attempts: 2 });
      report.applied.push(`route:${route.id}`);
    } catch (err) {
      report.failed.push({ id: `route:${route.id}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** List currently-configured route IDs (for drift detection against the manifest). */
export async function listConfiguredRoutes(): Promise<string[] | null> {
  if (!apisixEnabled()) return null;
  try {
    const res = await adminRequest("GET", "routes");
    const list = (res as { list?: Array<{ key?: string }> } | null)?.list ?? [];
    return list.map((r) => String(r.key ?? "").split("/").pop() ?? "").filter(Boolean);
  } catch (err) {
    logOnce("apisix:list", "warn", `[Apisix] route listing failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function apisixHealth(): Promise<IntegrationHealth> {
  if (!apisixEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  try {
    const res = await adminRequest("GET", "routes");
    return { enabled: true, ok: res !== null, latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
