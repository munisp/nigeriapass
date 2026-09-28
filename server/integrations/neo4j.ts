/**
 * Neo4j integration — fraud-ring graph mirror.
 *
 * WHY A GRAPH: fraud rings share devices, phones, plates, and bank accounts
 * across many "users". Relational joins answer "who owns X"; Cypher answers
 * "what clusters share X" in one traversal.
 *
 * ENABLE WHEN: fraud/abuse signals appear (chargeback clusters, promo abuse)
 * or toll evasion investigations start. The graph is a READ-ONLY mirror of
 * postgres — never authoritative; sync lag is acceptable (minutes).
 *
 * Env: NEO4J_URI (bolt://localhost:7687), NEO4J_USER, NEO4J_PASSWORD.
 * Compose profile: `graph`.
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
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
});

type Env = z.output<typeof envSchema>;

interface Neo4jSession {
  run(cypher: string, params?: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }>;
  close(): Promise<void>;
}
interface Neo4jDriver {
  session(opts?: Record<string, unknown>): Neo4jSession;
  verifyConnectivity(): Promise<void>;
  close(): Promise<void>;
}
interface Neo4jModule {
  driver(uri: string, auth: { scheme: string; principal: string; credentials: string }, config?: Record<string, unknown>): Neo4jDriver;
  auth: { basic(user: string, password: string): { scheme: string; principal: string; credentials: string } };
}

let _env: Env | null | undefined;
let _driver: Neo4jDriver | null = null;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Neo4j");
  return _env;
}

export function neo4jEnabled(): boolean {
  return env() !== null;
}

async function getDriver(): Promise<Neo4jDriver | null> {
  const e = env();
  if (!e) return null;
  if (_driver) return _driver;
  const mod = await importOptional<Neo4jModule>("neo4j-driver", "Neo4j");
  if (!mod || typeof mod.driver !== "function") return null;
  try {
    const driver = await withRetry(
      async () => {
        const d = mod.driver(e.NEO4J_URI, mod.auth.basic(e.NEO4J_USER, e.NEO4J_PASSWORD), {
          maxConnectionPoolSize: 20,
          connectionAcquisitionTimeout: 5000,
        });
        await d.verifyConnectivity();
        return d;
      },
      { label: "neo4j-connect", attempts: 3 },
    );
    _driver = driver;
    return driver;
  } catch (err) {
    logOnce("neo4j:fail", "warn", `[Neo4j] unreachable — fraud graph disabled (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/** Run a Cypher statement; returns null when disabled/error (never throws). */
async function runCypher(cypher: string, params: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>> | null> {
  const driver = await getDriver();
  if (!driver) return null;
  const session = driver.session();
  try {
    const res = await session.run(cypher, params);
    return res.records.map((r) => {
      const row: Record<string, unknown> = {};
      for (const key of (r as unknown as { keys: string[] }).keys ?? []) row[key] = r.get(key);
      return row;
    });
  } catch (err) {
    logOnce("neo4j:run", "warn", `[Neo4j] cypher failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ── Mirror writes (idempotent MERGEs) ─────────────────────────────────────────

export async function mirrorUser(user: { userId: number; phone?: string; nin?: string }): Promise<boolean> {
  const res = await runCypher(
    `MERGE (u:User {userId: $userId})
     SET u.phone = $phone, u.nin = $nin
     WITH u
     FOREACH (_ IN CASE WHEN $phone IS NULL THEN [] ELSE [1] END |
       MERGE (p:Phone {number: $phone}) MERGE (u)-[:USES_PHONE]->(p))
     FOREACH (_ IN CASE WHEN $nin IS NULL THEN [] ELSE [1] END |
       MERGE (n:NIN {number: $nin}) MERGE (u)-[:HAS_NIN]->(n))`,
    { userId: user.userId, phone: user.phone ?? null, nin: user.nin ?? null },
  );
  return res !== null;
}

export async function mirrorDevice(device: { deviceId: string; serial?: string; plazaId?: string }): Promise<boolean> {
  const res = await runCypher(
    `MERGE (d:Device {deviceId: $deviceId})
     SET d.serial = $serial, d.plazaId = $plazaId`,
    { deviceId: device.deviceId, serial: device.serial ?? null, plazaId: device.plazaId ?? null },
  );
  return res !== null;
}

export async function mirrorAccount(account: { walletId: number; userId: number; bankAccountRef?: string }): Promise<boolean> {
  const res = await runCypher(
    `MERGE (w:Wallet {walletId: $walletId})
     WITH w
     MATCH (u:User {userId: $userId})
     MERGE (u)-[:OWNS_WALLET]->(w)
     FOREACH (_ IN CASE WHEN $bankAccountRef IS NULL THEN [] ELSE [1] END |
       MERGE (b:BankAccount {ref: $bankAccountRef}) MERGE (w)-[:SETTLES_TO]->(b))`,
    { walletId: account.walletId, userId: account.userId, bankAccountRef: account.bankAccountRef ?? null },
  );
  return res !== null;
}

export async function mirrorDeviceTouch(userId: number, deviceId: string, at: string): Promise<boolean> {
  const res = await runCypher(
    `MATCH (u:User {userId: $userId}), (d:Device {deviceId: $deviceId})
     MERGE (u)-[r:TOUCHED_DEVICE]->(d)
     SET r.lastSeenAt = $at, r.count = coalesce(r.count, 0) + 1`,
    { userId, deviceId, at },
  );
  return res !== null;
}

// ── Fraud-ring analysis ───────────────────────────────────────────────────────

export interface FraudCluster {
  sharedAttribute: string;
  attributeType: "Phone" | "NIN" | "BankAccount" | "Device";
  userIds: number[];
  size: number;
}

/**
 * Find attributes shared by >= minUsers distinct users — the classic fraud-ring
 * signature (one phone/NIN/bank account across many "users").
 */
export async function findSharedAttributeClusters(minUsers = 3, limit = 50): Promise<FraudCluster[] | null> {
  const res = await runCypher(
    `MATCH (attr)<-[r]-(u:User)
     WHERE any(label IN labels(attr) WHERE label IN ['Phone','NIN','BankAccount','Device'])
     WITH attr, collect(DISTINCT u.userId) AS users
     WHERE size(users) >= $minUsers
     RETURN coalesce(attr.number, attr.ref, attr.deviceId) AS sharedAttribute,
            head([label IN labels(attr) WHERE label IN ['Phone','NIN','BankAccount','Device']]) AS attributeType,
            users AS userIds, size(users) AS size
     ORDER BY size DESC LIMIT $limit`,
    { minUsers, limit },
  );
  if (res === null) return null;
  return res.map((row) => ({
    sharedAttribute: String(row.sharedAttribute),
    attributeType: row.attributeType as FraudCluster["attributeType"],
    userIds: (row.userIds as unknown[]).map(Number),
    size: Number(row.size),
  }));
}

/**
 * Sync job stub: in the lakehouse design, parquet exports of users/devices/
 * wallets land in object storage; this job would stream them through the
 * mirror functions above. For now it accepts in-memory batches so a cron in
 * server/jobs can pump postgres rows through it.
 */
export async function syncMirrorBatch(batch: {
  users?: Array<{ userId: number; phone?: string; nin?: string }>;
  devices?: Array<{ deviceId: string; serial?: string; plazaId?: string }>;
  accounts?: Array<{ walletId: number; userId: number; bankAccountRef?: string }>;
}): Promise<{ synced: number; enabled: boolean }> {
  if (!neo4jEnabled()) return { synced: 0, enabled: false };
  let synced = 0;
  for (const u of batch.users ?? []) if (await mirrorUser(u)) synced++;
  for (const d of batch.devices ?? []) if (await mirrorDevice(d)) synced++;
  for (const a of batch.accounts ?? []) if (await mirrorAccount(a)) synced++;
  // TODO(phase-2): replace batch input with lakehouse parquet scan
  // (DuckDB read_parquet over s3://lakehouse/curated/...) when the lake exists.
  return { synced, enabled: true };
}

export async function neo4jHealth(): Promise<IntegrationHealth> {
  if (!neo4jEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  const driver = await getDriver();
  if (!driver) return { enabled: true, ok: false, error: "driver unavailable" };
  try {
    await driver.verifyConnectivity();
    return { enabled: true, ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function closeNeo4j(): Promise<void> {
  if (_driver) {
    await _driver.close().catch(() => undefined);
    _driver = null;
  }
}
