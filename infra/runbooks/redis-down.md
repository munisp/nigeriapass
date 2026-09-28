# Runbook: Redis down

**Severity: medium** (by design — the app degrades instead of failing).

## Blast radius when Redis is unavailable
| Feature | Degradation |
|---|---|
| JSON cache (`cacheGet/Set`) | Misses; reads fall through to postgres. Slower, correct. |
| Rate limiting (`makeRateLimitStore`) | Falls back to in-memory store — limits become PER-REPLICA (weaker). |
| WS pub/sub (`createPubSub`) | Cross-replica fan-out stops; events only reach locally-connected sockets. |
| USSD sessions (`ussdSessionStore`) | Falls back to in-memory Map — sessions break if the telco gateway hits a different replica. **User-visible.** |

## Detection
- `redisHealth()` → `{ ok: false }` on the health endpoint.
- Log line: `[Redis] unreachable — continuing without Redis`.

## Recovery
1. `docker compose -f infra/docker-compose.infra.yml --profile core ps redis`
   → restart if exited: `... up -d redis`.
2. AOF is enabled (`appendonly yes`, fsync everysec): data survives restarts;
   on corruption, Redis self-recovers or replay `appendonlydir/` manually.
3. If the volume is lost: acceptable — caches rebuild; USSD sessions expire in
   5 min; rate limits reset (note the abuse window).

## After recovery
- No app restart needed; `getRedis()` reconnects lazily.
- Watch for a DB load spike while caches are cold (pg_stat_statements mean_exec_time).

## Prevention
- Memory cap is 256mb with `allkeys-lru`; alert on `used_memory` > 80%.
- If USSD session loss becomes a recurring incident, promote Redis to a
  primary/replica pair with Sentinel before adding app complexity.
