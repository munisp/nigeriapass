# NigerianPass Platform — Deep Audit & Remediation Report v13

**Date:** 2026-09-28 · **Scope:** full monorepo (client, server, drizzle, tests) + out-of-scope production concerns
**Method:** 4 parallel read-only audit agents (stakeholders, orphans/docs, infrastructure, AI/ML) with file:line evidence, followed by 5 remediation agents. Honest-only standard: nothing claimed without code evidence.
**Final state:** `tsc --noEmit` 0 errors · Vitest **271/271 passing (23 files)** · production `vite build` clean (16s).

---

## Part 1 — Stakeholders & Onboarding Robustness

### 1.1 Stakeholder inventory (12 identified)

| # | Stakeholder | Onboarding path (as found) | Grade (0-5) as-found | Grade after v13 |
|---|---|---|---|---|
| 1 | Driver / applicant | 5-step wizard → OTP/OAuth → KYC submit | **2** (fake NIN verify, fake success screen, unvalidated submission path) | **4** (validated `kyc.submitDriver`, honest errors, encrypted drafts) |
| 2 | Vehicle owner | 4-step wizard | **2** (validated endpoint dead, FRSC verify faked) | **4** (wired to `kyc.registerVehicle`) |
| 3 | Fleet operator (KYB) | 5-step wizard | **2** (CAC verify faked, dead endpoint, NaN credit limit) | **4** (wired to `kyc.submitFleetKYB`, validated custom limits) |
| 4 | Admin reviewer | env-var bootstrap + admin promotion | **3** | **4** (audit-logged role changes, 7-role RBAC) |
| 5 | Plaza / gate operator | **none existed** | **1** | **3** (`operator` role + gating; full onboarding portal deferred P1) |
| 6 | Device owner / toll device | admin CRUD + seed | **4** | **4** (heartbeat auth via device token) |
| 7 | NFC card holder | none (provisioning open to any user!) | **1** | **3** (admin/operator-gated, keys masked, dedicated event table) |
| 8 | USSD user (feature phone) | *346# state machine | **2** (phone never linked to account; top-up/registration fabricated) | **4** (phone→user linking, DB sessions, honest flows) |
| 9 | Wallet holder | lazy auto-provision | **3** (fake TigerBeetle IDs, idempotency race) | **4** (atomic ledger ops, unique externalRef, toll debit path) |
| 10 | Payment providers (webhooks) | HMAC endpoints | **2** (reference mismatch = money never credited; demo bypass) | **4** (unified refs, raw-body HMAC fixed, atomic credit) |
| 11 | Platform owner | notification recipient | n/a | n/a |
| 12 | Field agent / installer / support / merchant / NIMC verifier | **absent** | **0** | **2** (roles + `agents` table added; full flows P1 backlog) |

### 1.2 Onboarding robustness verdict (as found → as fixed)
- **Auth**: dual split-brain auth systems caused redirect loops → unified on `useAuth`/tRPC; OTP demo code `123456` accepted *any phone* in misconfigured prod → **fail-closed now**.
- **Driver/vehicle/fleet flows**: all three bypassed the validated tRPC mutations for an unvalidated sync bucket; fake "verified via NIMC/FRSC/CAC" UI; fabricated success refs on error → all wired to validated endpoints, fake UX removed.
- **Review flow**: genuinely solid (grade 4) but reviewers could never see documents (uploads silently dropped) — upload pipeline is the top remaining P1.
- **Missing stakeholders** (P0–P2): plaza operator, field agent, device installer, account recovery, admin invitation/MFA, NIMC verifier, support role, merchant, UBO/KYB tiers, offboarding/session revocation, minors, diaspora, NFC self-service. Roles enum + sessions/revocation shipped; the rest are specced in Part 5.

---

## Part 2 — Infrastructure Robustness Grades (the 11 systems + neo4j)

| System | Present? | Grade as-found | What v13 added | Enable trigger |
|---|---|---|---|---|
| **postgres** | Yes (only real infra) | **3** — no FKs, no transactions, racy idempotency, `timestamptz` missing, fail-open `getDb()` | FKs, UNIQUE(externalRef), CHECK balance≥0, atomic credit/debit txns, pool tuning, timeouts, fail-fast prod, hardening.sql + backup.sh | already core |
| **tigerbeetle** | Name only (fake `TB<id>` strings) | **1** | real double-entry client (`server/integrations/tigerbeetle.ts`), deterministic idempotent transfer IDs, chart of accounts, compose service | when toll debits go live |
| **redis** | No | **0** | full module: cache, rate-limit store adapter, WS pub/sub, USSD session store (5-min TTL); compose core profile | ≥2 replicas |
| **mojaloop** | No | **0** | FSPIOP skeleton + ml-testing-toolkit profile; docs note NIBSS NIP is the practical Nigerian rail | DFSP interop only |
| **kafka** | No | **0** | kafkajs module (topics: toll.charges, wallet/kyc/audit events), Redpanda compose | high-volume toll events |
| **apisix** | No | **0** | admin-API client + declarative routes manifest + standalone config | edge gateway needed |
| **keycloak** | No | **0** | OIDC/JWKS verifier + realm export mapping backoffice roles | backoffice SSO |
| **openappsec** | No | **0** | local policy + apisix plugin wiring (edge profile) | public exposure hardening |
| **permify** | No | **0** | ReBAC client + schema (fleet→drivers, plaza→devices) | scoped multi-org access |
| **opensearch** | No | **0** | client + kyc_search/audit index templates (pg_trgm recommended first) | fuzzy KYC/log search |
| **fluvio** | No | **0** | CLI wrapper + guidance (no distinct role vs kafka today) | edge/Rust streaming |
| **neo4j** | No | **0** | driver + fraud-graph mirror sync from lakehouse | GNN production scoring |

Honest summary: as-found, **10 of 11 were absent and the 11th (postgres) was unhardened**. v13 ships real, env-gated, gracefully-degrading integrations + compose topology (`infra/docker-compose.infra.yml`, profiles: core/extended/edge/graph/interop). They are *ready*, not *running* — grades become real when the services are enabled.

---

## Part 3 — AI/ML/DL/GNN: from marketing copy to real stack

### 3.1 As-found verdict (honest)
Every "AI" claim was marketing or fail-open stub: liveness auto-passed with random scores (0.85+rand, default 0.92), NIN verification passed on HTTP 404, OCR/MiniFASNet/Qwen2-VL existed only in UI strings, KYC "score" was string-length heuristics, `invokeLLM`/`voiceTranscription` had zero callers. No weights, no training, no registry, no monitoring. Rule-based at best — not ML.

### 3.2 What v13 built (all real, all executed)
- **Trained models with shipped weights** (`ml/artifacts/{fraud,credit,gnn}/v1/model.pt + model.onnx`):
  - Fraud MLP — test **AUC 0.9960**, PR-AUC 0.8985 (14 features: velocity 1h/24h, amount z-score, device/IP sharing degree, KYC age, tier…)
  - Credit MLP — **AUC 0.8261** (fleet credit-limit scoring, monotonic transforms)
  - GraphSAGE GNN (pure-torch, 2-layer, neighbor sampling; 134,764 nodes / 203,112 edges) — **AUC 0.8440** for collusion/mule rings
- **Real training loops**: chronological splits, weighted BCE for imbalance, early stopping, full metrics, ONNX export (opset 17); ONNX↔torch parity 5.6e-18.
- **Realistic synthetic Nigerian data**: 50k users / 507k transactions; 37 states population-weighted, +234 phones, 11-digit NINs, plate formats, LogNormal top-ups (median ₦2,500), commute-hour patterns; 6 injected fraud classes (mule rings, velocity, SIM-swap, collusion clusters, chargebacks, synthetic IDs). Persisted as parquet lakehouse (bronze/silver/gold) — training reads FROM the lakehouse, not in-memory.
- **Lakehouse integration** + **Ray** distributed pipeline (activates when `ray`/`RAY_ADDRESS` present; validated local fallback otherwise).
- **Model registry**: MLflow tracking when `MLFLOW_TRACKING_URI` set, else versioned file registry with champion/challenger stages.
- **A/B testing**: deterministic hash-bucket champion/challenger router, assignments logged to lakehouse.
- **Monitoring**: PSI + KS drift detection + degradation alerts vs champion.
- **Continuous training**: `ml/jobs/continuous_training.py` ingests platform Postgres → lakehouse → reviewer-label merge → retrain → promote-only-if-better (dry run correctly rejected a degraded challenger, AUC 0.598).
- **CPU inference**: FastAPI scoring server, measured **p95 = 1.13ms**; Node bridge `server/ml/scoring.ts` with deterministic (non-random) heuristic fallback.
- **Honesty**: AUCs are on synthetic labels and are optimistic — documented in `docs/ML.md`; real-fraud validation requires the label pipeline (`fraud_labels` table added) fed by chargebacks/reviewer decisions.

---

## Part 4 — What was fixed (remediation ledger)

**P0 security/money (all fixed, tested):** OTP universal-login bypass; webhook HMAC demo-bypass + raw-body ordering; payment reference chaos unified to `NP-<PROVIDER>-<userId>-<ts>` with atomic idempotent crediting (double-credit race closed); dead unauthenticated `/api/payments/initiate` (credited the first wallet in the DB!) deleted; split-brain auth unified; fake NIN/CAC/FRSC/liveness verification paths fail closed; RBAC 7-role gating on devices/NFC; NFC keys masked + no hardcoded secrets; WS/heartbeat authentication; USSD fabricated top-up removed + phone→account linking; MySQL-dialect migrations replaced with full Postgres hardening migration (`0009`) + perf indexes (`0010`); orphan API-less `server/index.ts` deleted.

**P1 compliance/data (shipped):** `kyc.submitDriver` validated endpoint; sync per-type validation + idempotent replay; `audit_logs` + `kyc_status_history`; `sessions` + JWT revocation (`logoutAll`); refunds/disputes with 4-eyes >₦50k; NDPR data-rights router (export/erasure/consents) + retention job; `nfc_provisioning_events` (KYC queue no longer polluted); SMS contact-key fix; demo stats/wallet now flagged or error; helmet headers + sameSite=lax; toll debit path (`wallet.chargeToll`, atomic, daily caps).

**P2 hygiene:** 47+ orphan files deleted (ComponentShowcase, Home, ManusDialog, AIChatBox, DashboardLayout, 39 unused ui components, 5 dead `_core` modules, dead api clients); split vendor chunks, prod build strips debug plugins; rewritten service worker (SWR/network-first strategies); mobile budgets.

**Performance budgets** (`docs/PERFORMANCE.md`): webhook ack p95 ≤100ms · wallet reads ≤150ms · auth ≤300ms · admin queue ≤400ms · mobile TTI ≤3s on 3G mid-tier · initial bundle ≤350KB gzip (currently ~365KB — residual: route-level lazy imports). Server middleware (compression/ETag/response-time p95 tracking) + `/metrics` (Prometheus) wired into `_core/index.ts`.

**Anti-wipe filesystem protection** (`scripts/fs-guard/`, `docs/FS-GUARD.md`): SHA256 manifest, destructive-command guard (rm -rf/git clean/dd refused on protected paths), timestamped snapshots (10 retained), agent policy doc. Verified: `rm -rf .` refused, snapshot/restore works.

**Toolchains:** Go 1.22.12 installed (`~/toolchains/go-sdk`), TypeScript 7.0.2 global, Node 20.20.2, PyTorch 2.8.0. Rust: sandbox network could not complete rustup — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` on any normal machine.

---

## Part 5 — Unhandled scenarios: 68-item gap matrix (status after v13)

Severity P0 = money/regulatory now · P1 = exploitable/operational · P2 = product. "Model" = shipped in `ml/`.

### Fraud & security
| # | Scenario | Was | Now |
|---|---|---|---|
| 1 | SIM-swap takeover | none | P1 backlog (MNO API + re-KYC rule); login-anomaly model specced |
| 2 | OTP brute-force | partial | per-phone caps + prod fail-closed ✓ |
| 3 | QR replay at gates | partial | secret fail-closed + operator gating ✓; nonce/one-time-use P1 |
| 4 | Ghost field agents | none | `agents` table + role ✓; activity ML P1 |
| 5 | Synthetic identity | none | real NIMC/NIBSS integration still required (external dependency) |
| 6 | Biometric dedup (1:N) | none | face-embedding path documented (MobileFaceNet ONNX + pgvector); P1 |
| 7 | NFC cloning | partial | key masking + fail-closed secret ✓; NTAG 424 SUN counters P1 |
| 8 | USSD hijack | partial | HMAC mandatory + DB sessions ✓; USSD PIN P1 |
| 9 | Insider admin fraud | partial | audit trail + 4-eyes refunds ✓; dual-control approvals P1 |
| 10 | Wallet farming/mules | none | **fraud MLP shipped** + `fraud_labels` table ✓ |
| 11 | Promo abuse | none | P2 (no promo system) |
| 12 | Collusion rings | none | **GNN shipped** ✓ |
| 13 | Chargeback fraud | none | dispute webhook handling + funds freeze ✓ |
| 14 | Liveness spoof | fail-open | fail-closed ✓; MiniFASNet ONNX server anti-spoof P1 |
| 15 | Screen-replay | none | P1 (challenge nonce) |
| 16 | Webhook forgery | bypass | fail-closed HMAC ✓ |

### Money
| # | Scenario | Was | Now |
|---|---|---|---|
| 17-19 | Refunds / partial / chargebacks | none | refunds+disputes tables, 4-eyes, provider refund ✓ |
| 20 | Double credit | racy | UNIQUE externalRef + ON CONFLICT atomic credit ✓ (tested) |
| 21 | Duplicate /initiate | dead code | deleted ✓ |
| 22 | P2P transfers | none | P1 (ledger API ready via tigerbeetle module) |
| 23 | Cash-out | none | P1 |
| 24 | Agent float | none | P2 |
| 25 | Velocity/limits on debits | none (no debit path!) | `chargeToll` + daily caps ✓ |
| 26-28 | Dormant / negative balance / rounding | none/partial | CHECK balance≥0 ✓; dormancy job P2 |
| 29-31 | Recon breaks / unmatched funds / toll idempotency | broken | unified refs + atomic ops ✓; break-aging UI P1 |
| 32 | Low-balance notify | none | hook in chargeToll ✓ |

### Identity & compliance
| # | Scenario | Was | Now |
|---|---|---|---|
| 33 | Real NIN/BVN verify | faked | honest pending state ✓; NIMC/NIBSS API = external blocker |
| 34-35 | Sanctions/PEP · AML SAR/CTR | none | P0 backlog — pre-launch for wallet (screening provider + ₦5M NFIU reports) |
| 36-39 | NDPR export/erasure/rectify/consent | none | dataRights router + consents + retention ✓ |
| 40-42 | Minors / doc expiry / tamper | none | DOB ≥18 gate ✓; expiry cron P1; forgery CNN P1 |

### Operations & edge cases
| # | Scenario | Was | Now |
|---|---|---|---|
| 43-45 | Agent/plaza-operator onboarding, device loss/theft | none | roles + agents table + device lifecycle states ✓; portals P1 |
| 46-49 | Tamper events / bulk ops / review SLA / appeals | none/partial | P1 backlog (telemetry autoencoder specced) |
| 50-54 | Support tickets / i18n / feature-phone gaps / SMS fallback / notif prefs | none/partial | USSD honest flows ✓; rest P1–P2 (invokeLLM now has wiring target) |
| 55-58 | Retrain on prod data / drift / feedback labels / labeling | none | **continuous training + drift + fraud_labels shipped** ✓ |
| 59-62 | Phone change / lost phone / deceased / account merge | none | P0–P1 backlog (recovery via NIN+liveness specced) |
| 63-68 | Business dissolution / cross-border / shared phones / replay abuse / clock skew / WS replay | none/partial | idempotent replay ✓; rest P2 |

### Top remaining external blockers (not codeable from this repo)
1. **NIMC/NIBSS** NIN/BVN verification contracts. 2. **Africa's Talking** live keys (USSD/SMS). 3. **Sanctions list provider** (ComplyAdvantage/Dow Jones). 4. **Payment provider production keys**. 5. Real fraud labels from operations.

---

## Part 6 — Validation evidence
- `tsc --noEmit`: **0 errors** (final merged tree).
- `vitest run`: **271/271 passing, 23 files** (30 stale tests rewritten to assert hardened behavior; new suites: reference parsing, webhook idempotency/double-credit, RBAC gating, OTP prod fail-closed, USSD linking).
- `vite build` (production): clean, 16s, hashed chunks, debug plugins stripped.
- ML: real CPU training executed in-sandbox; smoke tests load all artifacts and score; serving p95 1.13ms measured.
- fs-guard: refuse/verify/snapshot flows tested.

*This report supersedes AUDIT_REPORT_V12.md, whose claims about Python/Go/Rust services, migration coverage, and test inventory were aspirational (those artifacts are external repos or were absent).*
