/**
 * OpenSearch integration — full-text KYC search + audit log analytics.
 *
 * ENABLE WHEN: the KYC review queue outgrows postgres `ILIKE '%term%'`
 * (roughly >100k applications or when reviewers need fuzzy name/NIN/phone
 * matching), or when audit logs need retention/search beyond the DB.
 * Until then drizzle queries remain the search path (audit grade 0 today).
 *
 * Indices:
 *   kyc_search   — kyc_applications flattened (name, phone, nin, plate…)
 *   audit_logs   — append-only admin/security events
 *
 * Env: OPENSEARCH_URL (e.g. http://localhost:9200), OPENSEARCH_INDEX_PREFIX.
 * Compose profile: `extended`.
 */

import {
  DISABLED_HEALTH,
  importOptional,
  logOnce,
  parseEnvOrNull,
  withRetry,
  z,
  type IntegrationHealth,
} from "./_common";

const envSchema = z.object({
  OPENSEARCH_URL: z.string().min(1),
  OPENSEARCH_INDEX_PREFIX: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

interface OsClient {
  indices: {
    putTemplate(opts: { name: string; body: unknown }): Promise<unknown>;
    exists(opts: { index: string }): Promise<{ body: boolean } | boolean>;
    create(opts: { index: string; body?: unknown }): Promise<unknown>;
  };
  bulk(opts: { body: unknown[]; refresh?: boolean | string }): Promise<{ body: { errors: boolean; items: unknown[] } }>;
  search(opts: { index: string; body: unknown }): Promise<{ body: { hits: { total: { value: number }; hits: Array<{ _id: string; _source: Record<string, unknown> }> } } }>;
  cluster: { health(opts?: Record<string, unknown>): Promise<{ body: { status: string } }> };
}
interface OsModule {
  Client: new (opts: { node: string } & Record<string, unknown>) => OsClient;
}

let _env: Env | null | undefined;
let _client: OsClient | null = null;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "OpenSearch");
  return _env;
}

export function opensearchEnabled(): boolean {
  return env() !== null;
}

function indexName(kind: "kyc_search" | "audit_logs"): string {
  return `${env()?.OPENSEARCH_INDEX_PREFIX ?? "np"}_${kind}`;
}

async function getClient(): Promise<OsClient | null> {
  const e = env();
  if (!e) return null;
  if (_client) return _client;
  const mod = await importOptional<OsModule>("@opensearch-project/opensearch", "OpenSearch");
  if (!mod || typeof mod.Client !== "function") return null;
  _client = new mod.Client({ node: e.OPENSEARCH_URL });
  return _client;
}

/** Index templates — flattened KYC formData + strict-date audit logs. */
export const INDEX_TEMPLATES: Record<string, unknown> = {
  np_kyc_template: {
    index_patterns: ["*_kyc_search", "kyc_search"],
    template: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          applicationId: { type: "integer" },
          userId: { type: "integer" },
          status: { type: "keyword" },
          fullName: { type: "text", fields: { keyword: { type: "keyword" } } },
          phone: { type: "keyword" },
          nin: { type: "keyword" },
          plateNumber: { type: "keyword" },
          formData: { type: "flattened" },
          createdAt: { type: "date" },
          updatedAt: { type: "date" },
        },
      },
    },
  },
  np_audit_template: {
    index_patterns: ["*_audit_logs", "audit_logs"],
    template: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          actorUserId: { type: "integer" },
          action: { type: "keyword" },
          resource: { type: "keyword" },
          resourceId: { type: "keyword" },
          ip: { type: "ip" },
          detail: { type: "object", enabled: false },
          createdAt: { type: "date" },
        },
      },
    },
  },
};

/** Idempotently register index templates. */
export async function ensureIndexTemplates(): Promise<boolean> {
  const client = await getClient();
  if (!client) return false;
  try {
    for (const [name, body] of Object.entries(INDEX_TEMPLATES)) {
      await client.indices.putTemplate({ name, body });
    }
    return true;
  } catch (err) {
    logOnce("os:template", "error", `[OpenSearch] template registration failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface KycSearchDoc {
  applicationId: number;
  userId: number;
  status: string;
  fullName?: string;
  phone?: string;
  nin?: string;
  plateNumber?: string;
  formData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogDoc {
  actorUserId: number | null;
  action: string;
  resource: string;
  resourceId?: string;
  ip?: string;
  detail?: unknown;
  createdAt: string;
}

/** Bulk-index documents; failures are logged, never thrown (search is a sidecar). */
export async function bulkIndex(kind: "kyc_search", docs: KycSearchDoc[]): Promise<boolean>;
export async function bulkIndex(kind: "audit_logs", docs: AuditLogDoc[]): Promise<boolean>;
export async function bulkIndex(kind: "kyc_search" | "audit_logs", docs: Array<KycSearchDoc | AuditLogDoc>): Promise<boolean> {
  const client = await getClient();
  if (!client || docs.length === 0) return false;
  const index = indexName(kind);
  const body = docs.flatMap((doc) => [{ index: { _index: index, _id: String((doc as KycSearchDoc).applicationId ?? crypto.randomUUID()) } }, doc]);
  try {
    const res = await client.bulk({ body, refresh: "wait_for" });
    if (res.body.errors) {
      logOnce(`os:bulk:${kind}`, "warn", `[OpenSearch] bulk index into ${index} had item errors`);
    }
    return true;
  } catch (err) {
    logOnce(`os:bulk-err:${kind}`, "warn", `[OpenSearch] bulk index failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface KycSearchQuery {
  term?: string; // fuzzy multi-field
  status?: string;
  nin?: string;
  phone?: string;
  plateNumber?: string;
  from?: number;
  size?: number;
}

/**
 * Search KYC applications. Returns null when OpenSearch is disabled — the
 * CALLER must then fall back to the existing drizzle ILIKE query. This is the
 * graceful-degradation contract; never throw from here.
 */
export async function searchKycApplications(
  q: KycSearchQuery,
): Promise<{ total: number; hits: Array<{ id: string; doc: KycSearchDoc }> } | null> {
  const client = await getClient();
  if (!client) return null;
  const must: unknown[] = [];
  const filter: unknown[] = [];
  if (q.term) {
    must.push({
      multi_match: {
        query: q.term,
        fields: ["fullName^3", "phone", "nin", "plateNumber", "formData.*"],
        fuzziness: "AUTO",
      },
    });
  }
  if (q.status) filter.push({ term: { status: q.status } });
  if (q.nin) filter.push({ term: { nin: q.nin } });
  if (q.phone) filter.push({ term: { phone: q.phone } });
  if (q.plateNumber) filter.push({ term: { plateNumber: q.plateNumber } });
  try {
    const res = await withRetry(
      () =>
        client.search({
          index: indexName("kyc_search"),
          body: {
            from: q.from ?? 0,
            size: Math.min(q.size ?? 20, 100),
            query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter } },
            sort: [{ createdAt: { order: "desc" } }],
          },
        }),
      { label: "opensearch-search", attempts: 2, baseDelayMs: 150 },
    );
    return {
      total: res.body.hits.total.value,
      hits: res.body.hits.hits.map((h) => ({ id: h._id, doc: h._source as unknown as KycSearchDoc })),
    };
  } catch (err) {
    logOnce("os:search", "warn", `[OpenSearch] search failed, caller should use SQL fallback: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function opensearchHealth(): Promise<IntegrationHealth> {
  if (!opensearchEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  const client = await getClient();
  if (!client) return { enabled: true, ok: false, error: "client unavailable" };
  try {
    const res = await client.cluster.health();
    const status = res.body.status;
    return { enabled: true, ok: status !== "red", latencyMs: Date.now() - started, detail: `cluster status ${status}` };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
