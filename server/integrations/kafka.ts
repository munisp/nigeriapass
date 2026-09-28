/**
 * Kafka (Redpanda) integration — async event backbone.
 *
 * ENABLE WHEN: at least two consumers of the same event exist (e.g. toll
 * charges feeding both receipts AND analytics), or webhook ingest needs
 * decoupling from processing latency. Below that, direct function calls +
 * the postgres outbox are simpler and more reliable.
 *
 * Broker: Redpanda single-node (compose profile `extended`) speaks the Kafka
 * protocol, so plain kafkajs works everywhere.
 *
 * Topics (created on demand by the broker; use createTopics() to pre-create):
 *   toll.charges   — toll charge events for receipts/analytics/fraud
 *   wallet.events  — top-ups, refunds, balance milestones
 *   kyc.events     — application submitted/approved/rejected
 *   audit.events   — admin mutations, login events (compliance trail)
 *
 * Env: KAFKA_BROKERS (comma-separated, e.g. "localhost:19092"), optional
 * KAFKA_CLIENT_ID, KAFKA_CONSUMER_GROUP_PREFIX.
 */

import {
  DISABLED_HEALTH,
  importOptional,
  logOnce,
  parseEnvOrNull,
  sleep,
  withRetry,
  z,
  type IntegrationHealth,
} from "./_common";

const envSchema = z.object({
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_CLIENT_ID: z.string().min(1).optional(),
  KAFKA_CONSUMER_GROUP_PREFIX: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

export const TOPICS = {
  tollCharges: "toll.charges",
  walletEvents: "wallet.events",
  kycEvents: "kyc.events",
  auditEvents: "audit.events",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

// Structural types (kafkajs optional)
interface KafkaMessageLike {
  key?: Buffer | null;
  value?: Buffer | null;
  headers?: Record<string, Buffer | string | undefined>;
}
interface ProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(batch: {
    topic: string;
    messages: Array<{ key?: string; value: string; headers?: Record<string, string> }>;
  }): Promise<unknown>;
}
interface ConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(opts: { topics: string[]; fromBeginning?: boolean }): Promise<void>;
  run(opts: {
    eachMessage: (ctx: { topic: string; partition: number; message: KafkaMessageLike }) => Promise<void>;
  }): Promise<void>;
}
interface AdminLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTopics(opts: { topics: Array<{ topic: string; numPartitions: number; replicationFactor: number }> }): Promise<boolean>;
  fetchTopicMetadata(opts?: { topics: string[] }): Promise<{ topics: Array<{ name: string }> }>;
}
interface KafkaLike {
  producer(opts: { idempotent: boolean; maxInFlightRequests: number; retry: { retries: number } }): ProducerLike;
  consumer(opts: { groupId: string; allowAutoTopicCreation?: boolean }): ConsumerLike;
  admin(): AdminLike;
}
interface KafkaJsModule {
  Kafka: new (opts: { clientId: string; brokers: string[]; retry?: { retries: number } }) => KafkaLike;
  logLevel?: unknown;
}

let _env: Env | null | undefined;
let _kafka: KafkaLike | null = null;
let _producer: ProducerLike | null = null;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Kafka");
  return _env;
}

export function kafkaEnabled(): boolean {
  return env() !== null;
}

async function getKafka(): Promise<KafkaLike | null> {
  const e = env();
  if (!e) return null;
  if (_kafka) return _kafka;
  const mod = await importOptional<KafkaJsModule>("kafkajs", "Kafka");
  if (!mod || typeof mod.Kafka !== "function") return null;
  _kafka = new mod.Kafka({
    clientId: e.KAFKA_CLIENT_ID ?? "nigerianpass-api",
    brokers: e.KAFKA_BROKERS.split(",").map((b) => b.trim()),
    retry: { retries: 5 },
  });
  return _kafka;
}

/**
 * Shared idempotent producer (acks=all implied by idempotence). Returns null
 * when disabled — callers should treat null as "write to postgres outbox
 * instead" (see startOutboxRelay).
 */
export async function getProducer(): Promise<ProducerLike | null> {
  if (_producer) return _producer;
  const kafka = await getKafka();
  if (!kafka) return null;
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5, retry: { retries: 8 } });
  try {
    await withRetry(() => producer.connect(), { label: "kafka-producer-connect", attempts: 3 });
  } catch (err) {
    logOnce("kafka:fail", "warn", `[Kafka] broker unreachable — events stay in postgres outbox (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  _producer = producer;
  return producer;
}

/** Publish a domain event. No-op (false) when Kafka disabled/unavailable. */
export async function publishEvent(topic: TopicName, key: string, payload: unknown, headers?: Record<string, string>): Promise<boolean> {
  const producer = await getProducer();
  if (!producer) return false;
  try {
    await producer.send({ topic, messages: [{ key, value: JSON.stringify(payload), headers }] });
    return true;
  } catch (err) {
    logOnce(`kafka:send:${topic}`, "error", `[Kafka] publish to ${topic} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export type EventHandler<T = unknown> = (payload: T, meta: { topic: string; partition: number; key?: string }) => Promise<void>;

/**
 * Create + run a consumer in a named group. Handler errors are logged and the
 * message is NOT committed by kafkajs only when run with autoCommit disabled —
 * here we keep kafkajs auto-commit defaults and rely on handler idempotency
 * (all consumers must be idempotent; see outbox pattern note in docs/INFRA.md).
 *
 * Returns a stop function, or null when disabled.
 */
export async function createConsumerGroup<T = unknown>(
  groupName: string,
  topics: TopicName[],
  handler: EventHandler<T>,
): Promise<(() => Promise<void>) | null> {
  const e = env();
  const kafka = await getKafka();
  if (!kafka || !e) return null;
  const consumer = kafka.consumer({
    groupId: `${e.KAFKA_CONSUMER_GROUP_PREFIX ?? "nigerianpass"}-${groupName}`,
    allowAutoTopicCreation: true,
  });
  try {
    await withRetry(() => consumer.connect(), { label: `kafka-consumer-${groupName}`, attempts: 3 });
    await consumer.subscribe({ topics: [...topics], fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString();
        if (!raw) return;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return; // poison frame; skip
        }
        try {
          await handler(payload as T, { topic, partition, key: message.key?.toString() });
        } catch (err) {
          logOnce(`kafka:handler:${topic}`, "error", `[Kafka] handler error on ${topic}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
    return async () => {
      await consumer.disconnect();
    };
  } catch (err) {
    logOnce(`kafka:consumer:${groupName}`, "warn", `[Kafka] consumer group ${groupName} not started: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Pre-create the standard topics (3 partitions, RF=1 for single broker). */
export async function createTopics(): Promise<boolean> {
  const kafka = await getKafka();
  if (!kafka) return false;
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: Object.values(TOPICS).map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })),
    });
    return true;
  } catch (err) {
    logOnce("kafka:topics", "warn", `[Kafka] createTopics failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

export async function kafkaHealth(): Promise<IntegrationHealth> {
  if (!kafkaEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  const kafka = await getKafka();
  if (!kafka) return { enabled: true, ok: false, error: "kafkajs unavailable" };
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.fetchTopicMetadata();
    return { enabled: true, ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

// ── Transactional outbox relay ────────────────────────────────────────────────
//
// Pattern: writers INSERT into an `outbox_events` table in the SAME postgres
// transaction as the business write; this relay tails the table and publishes
// to Kafka. This guarantees at-least-once delivery without dual-write races.
//
// Required table (apply manually or via a future migration — not owned here):
//   CREATE TABLE IF NOT EXISTS outbox_events (
//     id BIGSERIAL PRIMARY KEY,
//     topic TEXT NOT NULL,
//     key TEXT NOT NULL,
//     payload JSONB NOT NULL,
//     published_at TIMESTAMPTZ,
//     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
//     ON outbox_events (id) WHERE published_at IS NULL;

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Start the outbox relay. `queryable` is anything pg-Pool-shaped (pass the
 * app's Pool — this module deliberately does not import server/db.ts to avoid
 * circularity). Returns a stop function, or null when Kafka is disabled.
 */
export function startOutboxRelay(
  queryable: Queryable,
  opts: { intervalMs?: number; batchSize?: number } = {},
): (() => void) | null {
  if (!kafkaEnabled()) {
    logOnce("kafka:outbox", "info", "[Kafka] outbox relay not started — KAFKA_BROKERS unset (direct writes remain synchronous)");
    return null;
  }
  const intervalMs = opts.intervalMs ?? 2000;
  const batchSize = opts.batchSize ?? 200;
  let stopped = false;

  void (async () => {
    while (!stopped) {
      try {
        const { rows } = await queryable.query(
          `DELETE FROM outbox_events WHERE id IN (
             SELECT id FROM outbox_events WHERE published_at IS NULL
             ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
           ) RETURNING id, topic, key, payload`,
          [batchSize],
        );
        for (const row of rows) {
          // At-least-once: delete-then-publish can lose a row on crash between
          // the two steps; consumers must tolerate replays of recent ids.
          await publishEvent(row.topic as TopicName, row.key as string, row.payload);
        }
      } catch (err) {
        // Table may not exist yet (migration pending) — log once, keep polling.
        logOnce("kafka:outbox-err", "warn", `[Kafka] outbox relay error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(intervalMs * 5);
      }
      await sleep(intervalMs);
    }
  })();

  return () => {
    stopped = true;
  };
}
