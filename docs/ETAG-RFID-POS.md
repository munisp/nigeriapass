# eTag + RFID Lane Middleware & POS Tolling

This document describes the NigerianPass electronic toll collection (ETC)
stack: RFID windshield tags / eTags / NFC cards, the lane middleware that
charges wallets at the barrier, and the POS terminals that settle crossings
and top up wallets at the plaza.

---

## 1. Architecture

```
┌────────────────────┐   x-lane-token (HMAC)   ┌──────────────────────────────┐
│  Lane controller   │ ──────────────────────▶ │  lanes.ingestEvent /         │
│  (RFID/eTag reader)│  tRPC over HTTPS        │  lanes.ingestBatch (≤500)    │
│  offline buffer ───┼── store-and-forward ──▶ │                              │
└────────────────────┘                         └──────────────┬───────────────┘
                                                              │
                                          processLaneEvent()  ▼
                        ┌─────────────────────────────────────────────────────┐
                        │ a. Idempotency   — UNIQUE(eventUid), replay = no-op │
                        │ b. Tag resolution — rfid_tags, must be 'active'     │
                        │ c. Anti-passback — same tag+plaza < 5 min → blocked │
                        │ d. Fraud scoring — ml/scoring.scoreFraud (fallback  │
                        │    heuristic when ML server unreachable)            │
                        │ e. Atomic charge — debitWalletAtomic (same          │
                        │    primitive as wallet.chargeToll): conditional     │
                        │    decrement, idempotency key, daily cap            │
                        │ f. Ledger insert — lane_events (immutable)          │
                        │ g. Audit log + Kafka topic toll.charges (guarded)   │
                        │ h. Metrics counter (guarded, optional)              │
                        └──────────────┬──────────────────────────────────────┘
                                       ▼
                        wallet_transactions (PostgreSQL ledger;
                        TigerBeetle ID mapping on wallet_accounts)
                                       ▲
┌────────────────────┐                 │ creditWalletAtomic / debitWalletAtomic
│  POS terminals     │ ── pos router ──┘  (pos_terminals / pos_transactions)
│  (Paystack, Flutterwave, Interswitch, Moniepoint)
└────────────────────┘
```

**Source of truth:** `lane_events` is the immutable record of every tag read
(including failed, free and anti-passback-blocked reads). `wallet_transactions`
is the money ledger. Every charged event links the two via
`lane_events.walletTxnId`.

---

## 2. Data model (drizzle/migrations/0011_tolling.sql)

| Table | Purpose | Idempotency key |
|---|---|---|
| `rfid_tags` | Tag registry + lifecycle (issued → active → suspended/lost/replaced/decommissioned) | `UNIQUE(tagEpc)` |
| `lane_events` | Immutable lane-read ledger | `UNIQUE(eventUid)` |
| `pos_terminals` | Registered POS hardware per plaza | `UNIQUE(terminalId)` |
| `pos_transactions` | POS card transactions (toll payment / wallet top-up) | `UNIQUE(txnUid)` |

Enums: `tag_type`, `tag_status`, `lane_direction`, `charge_status`,
`pos_vendor`, `terminal_status`, `pos_txn_type`, `pos_txn_status`.

`tagEpc` is the EPC-96 identifier: **24 uppercase hex characters**, normalised
server-side (`^[0-9A-F]{24}$`).

---

## 3. Lane-controller authentication

Lane controllers authenticate per request with an HMAC token, following the
device-heartbeat pattern (audit v13, P0-9):

```
x-lane-token = HMAC_SHA256(secret, "lane:" + readerId)
```

Secret resolution order:

1. `LANE_HMAC_SECRET` (dedicated lane secret — preferred)
2. `NFC_MASTER_SECRET` — **fallback only when `LANE_HMAC_SECRET` is unset**,
   for single-secret deployments. Set a dedicated `LANE_HMAC_SECRET` in
   production so lane credentials can be rotated independently of NFC keys.

If neither secret is configured the endpoint **fails closed**
(`PRECONDITION_FAILED`) — no lane traffic is accepted without authentication.
Comparison is constant-time (`crypto.timingSafeEqual`).

---

## 4. API contracts (tRPC)

### 4.1 `lanes.ingestEvent` (lane auth)

```jsonc
// input
{
  "eventUid": "550e8400-e29b-41d4-a716-446655440000", // UUID, idempotency key
  "plazaId": "lagos-ibadan",
  "laneId": "lane-3",
  "readerId": "reader-lag-01",
  "deviceId": 42,            // optional FK to toll_devices
  "tagEpc": "E2806894000040012ABCD123",
  "direction": "exit",       // "entry" reads are recorded but free
  "amountKobo": 50000,       // optional exit override (distance-based pricing)
  "occurredAt": "2026-06-01T10:00:00Z"
}

// result
{
  "eventUid": "...", "chargeStatus": "charged", "duplicate": false,
  "laneEventId": 101, "walletId": 7, "amountKobo": 50000,
  "balanceAfter": 950000, "fraudScore": 0.04
}
```

`chargeStatus`: `charged` | `insufficient` | `free` (entry/zero fare) |
`exempt` | `queued` | `failed` (unknown/inactive tag, anti-passback, no
wallet). `duplicate: true` means the eventUid was already processed — the
stored result is returned and no charge is repeated.

### 4.2 `lanes.ingestBatch` (lane auth)

`{ readerId, events: LaneEventInput[] }` — max **500** events. Per-item
isolation: each item is validated and processed independently; one malformed
or failing item never fails the batch. Returns per-item results:

```jsonc
{ "received": 3, "processed": 2,
  "results": [
    { "eventUid": "...", "chargeStatus": "charged", "duplicate": false, ... },
    { "eventUid": "...", "chargeStatus": "failed", "reason": "unknown_tag" },
    { "eventUid": "bad", "chargeStatus": "failed", "reason": "invalid_payload" }
  ] }
```

### 4.3 Operator / admin endpoints

| Procedure | Role | Description |
|---|---|---|
| `lanes.recentEvents` | operator/admin | Paginated events per plaza, joined tag + wallet info |
| `lanes.laneSummary` | operator/admin | Today's (WAT) counts by chargeStatus, charged revenue, anti-passback count, top insufficient-fund tags |
| `lanes.tagHistory` | operator/admin/reviewer or tag owner | Lane events for one tag |
| `etag.issue` | operator | Register tag (CONFLICT on duplicate EPC) |
| `etag.activate` | wallet owner or operator | `issued → active` |
| `etag.suspend` / `etag.decommission` | operator/admin | reversible / terminal |
| `etag.reportLost` | owner or operator | terminal `lost` |
| `etag.replace` | operator/admin | transaction: old → `replaced` (+`replacedByTagId`), new EPC inserted `active`, wallet/plate carried over |
| `etag.linkWallet` | owner (own wallet) or operator | bind tag → wallet |
| `etag.myTags` | authenticated | caller's tags |
| `etag.getByEpc` / `etag.getByPlate` | operator/admin/reviewer | lookup |
| `etag.list` | operator/admin | paginated; filter by status, plaza (`meta->>'plazaId'`); search plate/EPC |

POS endpoints (`pos.*`) are documented alongside the POS router; the tables
above are the shared contract.

---

## 5. Tariff configuration

`PLAZA_TARIFFS_KOBO` in `server/routers/lanes.ts` maps plaza → flat exit fare
in kobo, with a `default` fallback. Rules:

- **Entry reads are free** (open system: entry recorded, exit charged).
- An `amountKobo` supplied by the lane controller on an **exit** event
  overrides the map (distance-based / vehicle-class pricing computed at the
  lane).
- Unknown plazas fall back to `DEFAULT_TOLL_KOBO`.

To move tariffs into the database later, swap `tariffForPlaza()` for a lookup
— the pipeline contract is unchanged.

---

## 6. Offline store-and-forward design

Lanes must keep operating through connectivity loss (Nigerian toll plazas
have unreliable uplinks):

1. **Reader side:** the lane controller persists every read locally
   (eventUid = reader-generated UUID) and opens the barrier per local policy
   (typically: allow known tags, queue the charge).
2. **Sync:** when the uplink returns, the controller replays buffered events
   via `ingestBatch` in occurredAt order.
3. **Server side:** `UNIQUE(eventUid)` + the idempotency pre-check make
   replays exact no-ops; the wallet debit uses
   `externalRef = NP-LANE-<eventUid>` with the wallet ledger's own
   `UNIQUE(externalRef)` + `ON CONFLICT DO NOTHING` guard, so a duplicate can
   never double-charge even if the pre-check races.
4. **Offline POS:** terminals queue card transactions as
   `status = 'queued_offline'` with a terminal-generated `txnUid`; the sync
   path is idempotent on `txnUid` in the same way.
5. **Client side:** the PWA's IndexedDB retry queue (see `sync_queue`) gives
   users the same store-and-forward semantics for top-ups and KYC drafts.

Anti-passback uses the **reader-reported `occurredAt`**, so replayed offline
events are evaluated against the true crossing time, not the sync time.

---

## 7. Fraud controls at the lane

- **Anti-passback:** the same tag read at the same plaza within **5 minutes**
  of a prior unblocked read is recorded with `antiPassbackBlocked = true` and
  never charged. (Blocked reads don't extend the window.)
- **ML scoring:** every charged event is scored by
  `server/ml/scoring.ts#scoreFraud` with lane-derived features — velocity
  (tag reads in the last 1h/24h), amount z-score vs the tag's own history,
  wallet age, time-of-day. The score is persisted on `lane_events.fraudScore`
  for review and model retraining. Scoring is **non-blocking**: when the ML
  server is unreachable the deterministic heuristic fallback is used, and a
  total scoring failure records `fraudScore = null` without stopping traffic.
- **Atomic ledger:** charging reuses the exact `debitWalletAtomic` primitive
  behind `wallet.chargeToll` — conditional decrement (`balance >= amount` in
  the UPDATE's WHERE clause), idempotency key, daily fare cap. Balances can
  never go negative.
- **Audit:** every outcome (`lane.charge`, `lane.insufficient`,
  `lane.anti_passback`, `lane.charge_failed`) is written to `audit_logs`,
  and charged events are published to Kafka topic `toll.charges`
  (best-effort; the Postgres row is authoritative).

---

## 8. Reconciliation

- `lane_events.walletTxnId ↔ wallet_transactions.id` gives a 1:1 join for
  every charged crossing.
- `lane_events` rows with `chargeStatus IN ('insufficient','failed','queued')`
  are the exception queue; `lanes.laneSummary` surfaces them per plaza.
- `pos_transactions.status = 'queued_offline'` rows are settled by the POS
  sync path and linked to lane events via `laneEventId` when they settle a
  crossing.
- Nightly reconciliation (`reconciliation_runs`) can cross-check
  `sum(lane_events.amountKobo where charged)` against wallet debits per plaza
  per day.

---

## 9. NigerianPass vs LCC eTag / HDMI (etoll) — superiority matrix

| Capability | LCC eTag (Lekki-Ikoyi) | HDMI / eTag legacy | **NigerianPass** |
|---|---|---|---|
| Identity-verified tags (KYC-bound) | ✗ anonymous tag, no identity | ✗ card only, no identity | ✓ every tag links to a KYC application + wallet owner |
| Top-up / payment channels | web + cash at plaza | card POS only | ✓ USSD (*346#), PWA, POS (4 vendors), Paystack/Flutterwave |
| Offline lane operation | ✗ lane stops or opens free | partial | ✓ store-and-forward batch ingest, idempotent replay |
| Offline client | ✗ | ✗ | ✓ PWA IndexedDB queue + service worker |
| Fraud ML at the lane | ✗ | ✗ | ✓ per-event scoring, velocity + amount z-score, deterministic fallback |
| Ledger integrity | opaque | opaque | ✓ atomic conditional decrement, UNIQUE idempotency keys, never-negative invariant, daily caps |
| Anti-passback | ✗ | ✗ | ✓ 5-minute same-plaza window, immutable record |
| Tag lifecycle security | basic | basic | ✓ issued→active→suspended/lost/replaced/decommissioned, HMAC lane auth, full audit trail |
| Reconciliation | manual | manual | ✓ per-plaza daily summary, exception queue, wallet↔event 1:1 join, provider RRN/STAN on POS |
| Multi-vendor POS | ✗ single acquirer | ✗ | ✓ Paystack, Flutterwave, Interswitch, Moniepoint terminals on one schema |

---

## 10. Ops notes

- Apply migration: `psql "$DATABASE_URL" -f drizzle/migrations/0011_tolling.sql`
  (idempotent; safe to re-run).
- Set `LANE_HMAC_SECRET` per environment; distribute per-reader tokens as
  `HMAC_SHA256(LANE_HMAC_SECRET, "lane:" + readerId)`.
- Rotate by introducing a new secret, re-issuing reader tokens, then removing
  the old one — lane auth is independent of user sessions.
