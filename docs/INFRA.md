# INFRA.md — infrastructure integration guide

Audit baseline (AUDIT_REPORT_V12.md): **PostgreSQL is the only real
infrastructure (grade 3)**. TigerBeetle, Redis, Kafka, APISIX, Keycloak,
open-appsec, Permify, OpenSearch, Fluvio, Neo4j and Mojaloop are all **absent
(grade 0)** — TigerBeetle has fake locally-generated string IDs in `db.ts`.
This document is the honest "what exists / what this layer adds / when to
switch it on" per system.

Compose: `docker compose -f infra/docker-compose.infra.yml --profile <p> up -d`
Integration modules: `server/integrations/*.ts` (zod-typed env, lazy connect,
graceful disable, retry/backoff, `*Health()`).

---

## 1. PostgreSQL — grade 3 (real)

- **Provides**: system of record for everything today (users, KYC, wallets,
  OTP, sync queue). Compose adds a tuned instance: `shared_buffers=2GB`,
  `work_mem=16MB`, `max_connections=200`, `wal_level=replica`, SSD-cost
  settings, optional TLS (`POSTGRES_SSL=on` after `gen-certs.sh`),
  `pg_stat_statements` preloaded, slow-query log >500ms.
- **Enable**: always on. This is the only non-optional system.
- **Env**: `POSTGRES_URL` / `DATABASE_URL` (consumed by `server/db.ts`).
- **Profile**: all (core).
- **Failover**: none today — single node. `wal_level=replica` + WAL archiving
  notes in `infra/postgres/backup.sh` prepare PITR and a future read replica.
- **Hardening checklist**: `infra/postgres/hardening.sql` — unique
  `externalRef` (webhook idempotency), `CHECK balanceKobo >= 0`, composite
  index on `(walletId, createdAt)`, statement/lock timeouts, least-privilege
  app role, pgbouncer notes (transaction pooling at >3 replicas).
- **Nigeria notes**: keep DB in-region (Lagos) for latency; data residency of
  KYC PII favours local hosting; `idle_in_transaction_session_timeout` matters
  on flaky 3G where clients abandon requests mid-transaction.

## 2. TigerBeetle — grade 0 → real client provided

- **Audit finding**: `wallet_accounts.tigerBeetleId` stores nanoid-style
  strings; no ledger exists.
- **Provides** (`server/integrations/tigerbeetle.ts`): real double-entry
  client (dynamic `tigerbeetle-node` import), chart of accounts
  (`user_wallet:<id>`, `provider_clearing:<paystack|flutterwave|interswitch>`,
  `operator_fees`, `refunds_holding`), `ledgerTopUp` / `ledgerTollCharge` /
  `ledgerRefund` with **idempotent transfer IDs derived from provider
  references**, and `reconcileBalances()` against the postgres cache.
- **Enable when**: external money movement (bank refunds) starts, or wallet
  row-lock contention/audit gaps in postgres become measurable. Requires the
  cutover runbook (`infra/runbooks/tigerbeetle-replication.md`) — replay via
  the deterministic IDs makes migration replay-safe.
- **Env**: `TIGERBEETLE_ADDRESSES`, `TIGERBEETLE_CLUSTER_ID`.
- **Profile**: `core` (single replica, `--development`); 3-node set per runbook.
- **Failover**: single replica = none; the app falls back to postgres-only
  wallet ops when TB is unreachable (log once). After 3-node cutover, one
  replica loss is transparent (VSR).
- **Nigeria notes**: users treat wallet balance as cash — ledger durability
  beats latency; 3 replicas across AZs before any launch that advertises
  "wallet".

## 3. Redis — grade 0 → full module provided

- **Provides** (`server/integrations/redis.ts`): `getRedis()`, `redisHealth()`,
  JSON `cacheGet/cacheSet/cacheDel` with TTL, `makeRateLimitStore()`
  (express-rate-limit adapter), `createPubSub()` for WebSocket scale-out,
  `ussdSessionStore` with 5-min TTL. ioredis is dynamically imported; absent
  package or `REDIS_URL` ⇒ no-op + one warning.
- **Enable when**: (a) USSD launches (sessions must survive deploys and
  gateway round-robin), (b) >1 app replica (rate limits, WS fan-out),
  (c) hot DB reads need caching.
- **Env**: `REDIS_URL`, `REDIS_PASSWORD` (compose), `REDIS_KEY_PREFIX`.
- **Profile**: `core`. Config: AOF everysec, `maxmemory 256mb`, `allkeys-lru`.
- **Failover**: cache misses fall through to DB; USSD sessions fall back to
  in-process Map (single-replica only — see `runbooks/redis-down.md`).
- **Nigeria notes**: telco USSD sessions die at ~120–180s; the 5-min TTL is
  deliberate headroom, and AOF matters because a reboot mid-session otherwise
  strands users at a confirmation prompt.

## 4. Kafka (Redpanda) — grade 0 → module provided

- **Provides** (`server/integrations/kafka.ts`): kafkajs dynamic import,
  topics `toll.charges`, `wallet.events`, `kyc.events`, `audit.events`,
  idempotent producer, consumer-group helper, and a **postgres outbox relay**
  (`startOutboxRelay`) so event publishing survives broker outages.
- **Enable when**: ≥2 consumers of the same event (e.g. receipts + analytics)
  or webhook ingest must decouple from processing time. Redpanda chosen over
  Apache Kafka: single binary, no JVM/ZooKeeper — cheaper to run in-region.
- **Env**: `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `KAFKA_CONSUMER_GROUP_PREFIX`.
- **Profile**: `extended` (single broker; RF=1).
- **Failover**: producer null → events accumulate in `outbox_events` and drain
  when the broker returns (at-least-once; consumers must be idempotent).
- **Nigeria notes**: cross-AZ replication is expensive on local bandwidth;
  keep RF=1 in dev, RF=3 only when the cluster is multi-node.

## 5. Keycloak — grade 0 → OIDC verifier provided

- **Provides** (`server/integrations/keycloak.ts`): discovery, JWKS token
  verification (`jose`, already a dependency), realm-role → platform-role
  mapping (`admin/operator/reviewer/support`, precedence ordered). Realm
  import: `infra/keycloak/realm-export.json` (includes the `roles` claim
  mapper and a demo reviewer).
- **Enable when**: the backoffice console ships and staff need SSO/revocation.
- **Env**: `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`.
- **Profile**: `extended` (postgres-backed, `start-dev` — switch to `start`
  + TLS + hostname for prod).
- **Failover**: `verifyBackofficeToken` returns null → backoffice 401s; the
  customer app is unaffected because it never touches Keycloak.
- **Nigeria notes**: **do not migrate end users here.** Phone-OTP
  (`server/services/otp.ts`) is the right mass-market auth — no passwords, no
  email, no IdP round-trip on 2G. Keycloak is staff tooling.

## 6. Permify — grade 0 → ReBAC client provided

- **Provides** (`server/integrations/permify.ts`): schema (`organization` =
  fleet/plaza, `device`, `application`, `wallet`), `checkAccess()`,
  `addDriverToFleet`, `assignDeviceToPlaza/Fleet`, `assignApplicationReviewer`,
  `writeSchema`. Postgres-backed Permify.
- **Enable when**: fleets/plazas manage their own resources (multi-tenant
  delegation). Global roles alone can't express "fleet manager revokes only
  THEIR devices".
- **Env**: `PERMIFY_URL`, `PERMIFY_TENANT_ID`.
- **Profile**: `extended`.
- **Failover**: **fail-closed** — checks return false on outage. A degraded
  authz layer must deny, not allow; pair with caching only after measuring.
- **Nigeria notes**: transport-union fleets are hierarchical and fluid
  (drivers move between unions); relationship tuples model that churn better
  than role tables.

## 7. OpenSearch — grade 0 → client + templates provided

- **Provides** (`server/integrations/opensearch.ts`): index templates for
  `kyc_search` (flattened `formData`, keyword phone/NIN/plate) and
  `audit_logs`, `bulkIndex`, `searchKycApplications()` which **returns null so
  callers fall back to the existing drizzle ILIKE query**. Dashboards included.
- **Enable when**: KYC review search outgrows ILIKE (>~100k applications or
  fuzzy matching requirements) or audit retention exceeds DB comfort.
- **Env**: `OPENSEARCH_URL`, `OPENSEARCH_INDEX_PREFIX`.
- **Profile**: `extended` (single-node, security plugin disabled in dev —
  enable TLS + internal users for prod).
- **Failover**: null → SQL fallback. Search is a sidecar, never the request path.
- **Nigeria notes**: fuzzy name matching matters (variant spellings of Yoruba/
  Igbo/Hausa names across NIN vs self-reported data) — that's the real trigger
  for enabling this, not raw volume alone.

## 8. Neo4j — grade 0 → graph mirror provided

- **Provides** (`server/integrations/neo4j.ts`): driver (dynamic
  `neo4j-driver`), `mirrorUser/Device/Account/DeviceTouch` MERGE helpers,
  `findSharedAttributeClusters()` (phone/NIN/bank/device shared across ≥N
  users — the fraud-ring signature), `syncMirrorBatch()` stub awaiting
  lakehouse parquet exports.
- **Enable when**: fraud patterns appear (chargeback clusters, promo/toll
  abuse) — not before.
- **Env**: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`.
- **Profile**: `graph` (community + GDS plugin).
- **Failover**: read-only mirror; outage blocks fraud analysis only. Sync lag
  of minutes is acceptable.
- **Nigeria notes**: SIM-swap and shared-device farming are the dominant local
  fraud shapes; the `TOUCHED_DEVICE` edge exists specifically for those.

## 9. APISIX — grade 0 → admin client + manifest provided

- **Provides** (`server/integrations/apisix.ts` + `infra/apisix-routes.json`):
  declarative routes/upstreams (tRPC, webhooks, USSD, PWA catch-all, disabled
  backoffice+OIDC+openappsec route), `syncApisixRoutes()` with `${ENV_VAR}`
  hydration, drift check via `listConfiguredRoutes()`. Compose runs standalone
  mode (file-backed data plane) with etcd available for the future.
- **Enable when**: multiple replicas need central rate limiting/WAF/OIDC at
  the edge, or canary upstreams. In dev Express serves directly.
- **Env**: `APISIX_ADMIN_URL`, `APISIX_ADMIN_KEY`, `APISIX_ROUTES_FILE`.
- **Profile**: `edge`.
- **Failover**: app unaffected (it doesn't depend on APISIX to run); gateway
  outage at the edge is a load-balancer concern, not app code.
- **Nigeria notes**: webhook route must NOT be IP-rate-limited by caller
  (provider egress IPs are shared); authenticity stays signature-based in
  `server/payments`.

## 10. open-appsec — grade 0 → policy + attachment notes provided

- **Provides**: local policy (`infra/openappsec/local_policy.yaml`,
  detect-learn first), compose agent container, and the `openappsec` plugin
  reference in the APISIX manifest. Real attachment requires baking the agent
  into the apisix image (or sidecar sharing `/ext`) — documented in compose.
- **Enable when**: APISIX is enabled AND public traffic warrants a WAF
  (toll/payment endpoints are attack bait).
- **Env**: `OPENAPPSEC_TOKEN` (SaaS portal) or empty = local policy.
- **Profile**: `edge`.
- **Failover**: agent absent → plugin absent → traffic flows unfiltered
  (fail-open at the WAF layer; authn/z is unaffected). Start in detect-learn
  and graduate to prevent; keep `/api/webhooks` in detect longest — a false
  block there loses real money events.
- **Nigeria notes**: expect card-testing and credential-stuffing waves around
  salary weeks; WAF + rate limits are the first line, ledger idempotency the
  last.

## 11. Fluvio — grade 0 → CLI wrapper provided (disabled by default)

- **Provides** (`server/integrations/fluvio.ts`): produce/consume wrappers via
  the fluvio CLI, topic helpers, health. Explicitly a **note-module**: prefer
  it over Kafka only for edge (plaza boxes with intermittent uplinks,
  store-and-forward) or a Rust-heavy team with SmartModule (WASM) in-stream
  filtering needs. Compose runs a local dev cluster; prod = Helm on k8s.
- **Env**: `FLUVIO_ENABLED=true`, `FLUVIO_PROFILE`.
- **Profile**: `graph`.
- **Failover**: disabled by default; kafka.ts is the default backbone.
- **Nigeria notes**: plaza edge boxes on cellular uplinks are the one place
  Fluvio's model clearly beats Kafka's — enable only when those boxes exist.

## 12. Mojaloop — grade 0 → phase-3 FSPIOP skeleton

- **Provides** (`server/integrations/mojaloop.ts`): parties/quotes/transfers
  FSPIOP client skeleton against `ml-testing-toolkit` (compose `interop`) for
  dev simulation. Clearly marked **phase 3** — not wired to any flow.
- **Enable when**: regional/cross-border interop becomes real. **Domestic
  Nigerian interop is NIBSS NIP, not Mojaloop** — if bank-to-wallet transfers
  are needed domestically, integrate NIBSS (directly or via a switch like
  Hydrogen/Mono/Flutterwave's rails), not this.
- **Env**: `MOJALOOP_BASE_URL`, `MOJALOOP_DFSP_ID`.
- **Profile**: `interop` (testing toolkit only; a full hub is 15+ services).
- **Failover**: n/a — nothing depends on it.

---

## Metrics & tracing (`server/integrations/metrics.ts`)

In-process instrumentation, no container: prom-client registry (HTTP/tRPC
latency histograms labeled by route, DB pool gauges, webhook outcome
counters), `metricsExpressHandler` for `GET /metrics` (gated by
`METRICS_ENABLED=true`), and `initTracing()` (OTLP/HTTP, gated by
`OTEL_EXPORTER_OTLP_ENDPOINT`). prom-client and @opentelemetry/* are optional
deps — absent ⇒ no-op. Mount in `server/_core/index.ts` (owned by another
workstream; this module only exposes the pieces).

## Optional npm dependencies

Install only what you enable: `ioredis`, `kafkajs`, `tigerbeetle-node`,
`neo4j-driver`, `@opensearch-project/opensearch`, `prom-client`,
`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`.
Everything degrades gracefully without them (verified by design: dynamic
imports + one-time warnings).
