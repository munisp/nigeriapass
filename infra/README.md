# infra/ — NigerianPass infrastructure integration layer

Everything here is **opt-in**. The app boots with zero infrastructure beyond
postgres (or even without it). Each system below has a matching module in
`server/integrations/` that disables itself gracefully when its env vars are
absent. Full per-system details (env vars, failover, Nigerian-production notes)
are in [docs/INFRA.md](../docs/INFRA.md).

## Audit truth (AUDIT_REPORT_V12.md)

| System | Current grade | Status |
|---|---|---|
| PostgreSQL | **3** | Real, in production path |
| TigerBeetle | 0 | Absent — `db.ts` stores fake string IDs |
| Redis | 0 | Absent |
| Kafka/Redpanda | 0 | Absent |
| Keycloak | 0 | Absent |
| Permify | 0 | Absent |
| OpenSearch | 0 | Absent |
| APISIX | 0 | Absent |
| open-appsec | 0 | Absent |
| Fluvio | 0 | Absent |
| Mojaloop | 0 | Absent |
| Neo4j | 0 | Absent |

## Quick start

```bash
cp infra/.env.example .env   # set passwords
docker compose -f infra/docker-compose.infra.yml --profile core up -d
# add when needed:
#   --profile extended   redpanda, keycloak, permify, opensearch(+dashboards)
#   --profile edge       apisix, etcd, openappsec agent
#   --profile graph      neo4j, fluvio
#   --profile interop    mojaloop ml-testing-toolkit (dev simulation only)
```

## Layout

```
infra/
├── docker-compose.infra.yml    # 12 services, 5 profiles, healthchecks + limits
├── apisix-routes.json          # declarative route manifest (synced by apisix.ts)
├── apisix/                     # standalone-mode config mounts
├── keycloak/realm-export.json  # backoffice realm (staff SSO only)
├── permify/schema.perm         # ReBAC model (orgs=fleets/plazas)
├── openappsec/local_policy.yaml
├── postgres/
│   ├── hardening.sql           # FK/index/constraint checklist + pooling notes
│   ├── backup.sh               # pg_dump + WAL/PITR notes
│   └── gen-certs.sh            # dev self-signed certs for POSTGRES_SSL=on
└── runbooks/                   # webhook failure, redis down, TB replication, drift
```

## Contract with server/integrations

Each module: zod-typed env, lazy connect, `*Health()` fn, retry/backoff,
one-line "disabled" log when env is missing, **never crashes the host app**.
Optional npm deps (ioredis, kafkajs, tigerbeetle-node, …) are dynamically
imported — install them only when enabling the matching profile.
