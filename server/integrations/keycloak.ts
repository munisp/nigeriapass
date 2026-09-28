/**
 * Keycloak integration — backoffice SSO via OIDC.
 *
 * NIGERIAN-PRODUCTION NOTE: Keycloak is for STAFF ONLY. The mass market
 * (drivers, commuters) authenticates with phone-number + OTP via
 * server/services/otp.ts — no passwords, no email, no IdP round-trip on 2G.
 * Do not migrate end users to Keycloak; the OTP path is the product.
 *
 * ENABLE WHEN: a backoffice/admin console ships and staff need SSO, role
 * management, and session revocation without touching platform code.
 *
 * Env: KEYCLOAK_URL (e.g. http://localhost:8080), KEYCLOAK_REALM
 * (default "nigerianpass"), KEYCLOAK_CLIENT_ID. Compose profile: `extended`.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { DISABLED_HEALTH, logOnce, parseEnvOrNull, withRetry, z, type IntegrationHealth } from "./_common";

const envSchema = z.object({
  KEYCLOAK_URL: z.string().min(1),
  KEYCLOAK_REALM: z.string().min(1).optional(),
  KEYCLOAK_CLIENT_ID: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

/** Platform backoffice roles — mapped from Keycloak realm roles. */
export type PlatformRole = "admin" | "operator" | "reviewer" | "support";

/** Precedence when a user holds multiple Keycloak roles. */
const ROLE_PRECEDENCE: PlatformRole[] = ["admin", "operator", "reviewer", "support"];

export interface BackofficeIdentity {
  subject: string;
  email?: string;
  name?: string;
  keycloakRoles: string[];
  platformRole: PlatformRole | null;
  claims: JWTPayload;
}

interface OidcDiscovery {
  jwks_uri: string;
  issuer: string;
  token_endpoint: string;
  authorization_endpoint: string;
}

let _env: Env | null | undefined;
let _discovery: OidcDiscovery | null = null;
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Keycloak");
  return _env;
}

export function keycloakEnabled(): boolean {
  return env() !== null;
}

export function keycloakUrls(): { realmBase: string; discoveryUrl: string } | null {
  const e = env();
  if (!e) return null;
  const realm = e.KEYCLOAK_REALM ?? "nigerianpass";
  const base = e.KEYCLOAK_URL.replace(/\/$/, "");
  const realmBase = `${base}/realms/${realm}`;
  return { realmBase, discoveryUrl: `${realmBase}/.well-known/openid-configuration` };
}

/** Fetch (and cache) the OIDC discovery document. */
export async function getOidcConfig(): Promise<OidcDiscovery | null> {
  const urls = keycloakUrls();
  if (!urls) return null;
  if (_discovery) return _discovery;
  try {
    _discovery = await withRetry(
      async () => {
        const res = await fetch(urls.discoveryUrl, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
        return (await res.json()) as OidcDiscovery;
      },
      { label: "keycloak-discovery", attempts: 3 },
    );
    return _discovery;
  } catch (err) {
    logOnce("kc:discovery", "warn", `[Keycloak] discovery failed — backoffice SSO disabled (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/** Map Keycloak realm roles to the single effective platform role. */
export function mapKeycloakRoles(roles: string[]): PlatformRole | null {
  const set = new Set(roles.map((r) => r.toLowerCase()));
  for (const role of ROLE_PRECEDENCE) {
    if (set.has(role)) return role;
  }
  return null;
}

/**
 * Verify a bearer token issued by the Keycloak realm and map it to a
 * backoffice identity. Returns null for any invalid/expired/role-less token.
 * Callers (backoffice middleware) should 401 on null.
 */
export async function verifyBackofficeToken(token: string): Promise<BackofficeIdentity | null> {
  const discovery = await getOidcConfig();
  const e = env();
  if (!discovery || !e) return null;
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  try {
    const { payload } = await jwtVerify(token, _jwks, {
      issuer: discovery.issuer,
      audience: e.KEYCLOAK_CLIENT_ID ?? "nigerianpass-backoffice",
    });
    const keycloakRoles = extractRoles(payload);
    return {
      subject: payload.sub ?? "",
      email: typeof payload.email === "string" ? payload.email : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      keycloakRoles,
      platformRole: mapKeycloakRoles(keycloakRoles),
      claims: payload,
    };
  } catch {
    return null; // expired, bad signature, wrong audience — all 401
  }
}

/** Roles arrive either as a flat `roles` claim (realm mapper in
 * infra/keycloak/realm-export.json) or nested under realm_access. */
function extractRoles(payload: JWTPayload): string[] {
  if (Array.isArray(payload.roles)) return payload.roles.filter((r): r is string => typeof r === "string");
  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  if (realmAccess && Array.isArray(realmAccess.roles)) {
    return realmAccess.roles.filter((r): r is string => typeof r === "string");
  }
  return [];
}

export async function keycloakHealth(): Promise<IntegrationHealth> {
  if (!keycloakEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  const discovery = await getOidcConfig();
  if (!discovery) return { enabled: true, ok: false, error: "discovery failed" };
  return { enabled: true, ok: true, latencyMs: Date.now() - started, detail: discovery.issuer };
}

/** Test hook: drop cached discovery/JWKS (e.g. after realm rotation). */
export function resetKeycloakCaches(): void {
  _discovery = null;
  _jwks = null;
}
