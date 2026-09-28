# ML Stack — NigeriaPass KYC + Wallet + Toll PWA

End-to-end AI/ML/DL/GNN stack for fraud detection, fleet credit scoring, and
fraud-ring (GNN) detection. Everything runs CPU-first.

```
ml/
  synthetic/generate.py     realistic Nigerian synthetic data (bronze)
  synthetic/features.py     bronze -> silver -> gold feature engineering
  lakehouse/                parquet lakehouse (bronze/silver/gold)
  models/                   FraudMLP, CreditMLP, pure-torch GraphSAGE
  training/                 train_fraud.py / train_credit.py / train_gnn.py
  pipeline/ray_pipeline.py  Ray-parallel sweep w/ local fallback
  registry/registry.py      MLflow when configured, else file registry
  serving/ab_router.py      deterministic champion/challenger router
  serving/score_server.py   FastAPI CPU inference (ONNX Runtime or torch)
  monitoring/drift.py       PSI + KS drift, degradation alerts
  jobs/continuous_training.py  Postgres -> lakehouse -> retrain -> promote
  artifacts/                trained weights (model.pt + model.onnx + meta.json)
server/ml/                  Node bridge (features.ts, scoring.ts)
```

## Architecture

```
Postgres (users, kyc_applications, wallet_transactions)
        |  continuous_training.py (nightly; synthetic fallback)
        v
lakehouse bronze -> silver -> gold (parquet)
        |                              \
        v                               v
train_fraud / train_credit        train_gnn (GraphSAGE)
        |                               |
        v                               v
registry (MLflow or file)  <- metrics/params/artifacts
        |
        v
ab_router (hash split, logged) -> score_server (ONNX/torch)
        ^                               ^
        |                               |
server/ml/scoring.ts (typed client, heuristic fallback)
        |
        v
monitoring/drift.py (PSI/KS + AUC degradation -> alerts)
```

## Models

| Model | Task | Arch | Features | Labels |
|---|---|---|---|---|
| fraud | tx-level fraud probability | MLP 14-64-64-64-1, weighted BCE | velocity 1h/24h, amount z-score, device/IP sharing degree, KYC age/tier, time-of-day | injected fraud patterns + reviewer rejects |
| credit | probability of default -> limit | MLP 10-64-64-64-1 | activity/balance/tier features, monotone log1p transforms (scorecard-style) | synthetic default process |
| gnn | user-node fraud-ring membership | 2-layer GraphSAGE (mean agg, fanout 10/10, pure torch) | node type, tier, degree, account age | mule-ring + collusion membership |

Fraud/credit models bake their standardization scaler INTO the graph
(registered buffers), so `model.onnx` consumes raw features — no train/serve
skew. GNN ONNX export is attempted (opset 17, dynamic node/edge axes) but
`index_add` support is runtime-dependent; when export fails the torch `.pt`
remains the serving artifact and the score server notes `backend: "torch"`.

## Data generation (honest documentation)

`ml/synthetic/generate.py` is seedable/deterministic. Distributions are
chosen to be plausible for Nigerian toll-wallet usage, NOT measured:

- States weighted ~population (Lagos 15%, Kano 9.5%, ... Bayelsa 1.4%).
- Phones: real MSISDN prefixes (070x/080x/081x/090x/091x). NINs: 11 digits.
- Top-ups ~ LogNormal(ln 2500, 1.05) → median ~₦2,500, heavy right tail.
- Toll charges ~ LogNormal(ln 350, 0.55). Amounts rounded to ₦5.
- Time-of-day: ~45% of activity in commute peaks (07-09h, 17-20h WAT).
- ~2% fraud injected: mule rings (shared device+IP, circular transfers),
  velocity bursts (8-20 tx/h), SIM-swap drains (new device, odd hours),
  agent-applicant collusion clusters (one agent device, many approvals),
  chargeback abuse, synthetic-identity NIN/phone mutations.

**These labels are ground truth by construction, which makes reported AUCs
optimistic vs. real fraud.** See Limitations.

## Registry & A/B

- `MLFLOW_TRACKING_URI` set + `mlflow` installed → params/metrics/artifacts
  logged to MLflow (file registry still updated for stage tracking).
- Else file registry at `ml/registry/store/<model>/registry.json` with
  versions, metrics, champion/challenger stage.
- `ab_router.assign(model, user_id)` → deterministic MD5 bucket (0-99);
  challenger gets `< challenger_pct` (default 10%). Every assignment is
  logged to `lakehouse/gold/ab_assignments/`.
- Promotion: `continuous_training.py` promotes the challenger only when
  `challenger_auc >= champion_auc + margin` (default margin 0.001).

## Monitoring

`ml/monitoring/drift.py`:
- PSI per feature (drift if > 0.25) and two-sample KS (D > 1.36·√((n+m)/nm)).
- Degradation: re-score labeled live rows, alert if AUC drops > 0.05 vs
  champion's registered AUC.
- Alerts: JSON in `ml/monitoring/alerts/` + console + optional
  `MONITORING_WEBHOOK_URL` POST.

## Continuous training

`python -m ml.jobs.continuous_training`
1. If `POSTGRES_URL`/`DATABASE_URL` set and a psycopg driver is installed,
   ingest production tables to bronze; else synthetic fallback (audited).
2. Merge reviewer decisions (`rejected` KYC → positive fraud labels).
3. Rebuild silver/gold, retrain fraud challenger, promote-if-better.
4. Full audit trail in `ml/jobs/audit/continuous_training.jsonl`.

Suggested cadence: nightly 02:00 WAT; weekly GNN retrain (graph is heavier).

## Serving (CPU)

```
ML_SCORING_PORT=8090 python -m uvicorn ml.serving.score_server:app
```

- Batch-1 ONNX Runtime inference of the MLPs is sub-millisecond; even under
  naive per-request overhead the p95 SLO is **< 20ms** (measured latencies
  exposed at `/healthz`). The GNN endpoint runs full-graph forward passes —
  use it for small subgraphs (< ~100k edges) or precompute embeddings nightly
  for fleet-wide scoring.
- Node side: `server/ml/scoring.ts` honours `ML_SCORING_URL`, 800ms timeout,
  deterministic heuristic fallback (no more random fail-open scores).

## Enabling Ray / MLflow

```
pip install ray mlflow
export RAY_ADDRESS=ray://head:10001        # optional; else local ray.init
export MLFLOW_TRACKING_URI=http://localhost:5000
python -m ml.pipeline.ray_pipeline          # parallel sweep
```

Everything works without them via import guards (local fallback paths are
the same functions, run sequentially).

## Honest limitations

1. **Synthetic labels.** Models are trained on injected fraud patterns with
   known ground truth. Real-world AUC will be lower; treat current metrics
   as pipeline-validation numbers, not production readiness.
2. **Need real labels.** Wire reviewer outcomes and confirmed chargebacks
   into `merge_reviewer_labels` (already implemented) and retrain before
   acting on scores. Keep thresholds conservative until then.
3. **GNN leakage risk.** Shared device/IP edges are strong ring signals in
   the synthetic world; on real data collusion may be subtler.
4. **ONNX GNN.** Export depends on onnx opset support for `index_add`;
   torch fallback is used otherwise.
5. **Feature parity.** `server/ml/features.ts` mirrors
   `ml/synthetic/features.py` by hand — changes must be made in both places
   (the smoke test guards the Python side only).
6. **No online feature store.** Velocity/degree features are computed from
   drizzle queries at request time; cache hot users if p95 suffers.

## Validation report (measured on this repo, CPU, seed 42)

Dataset: 50,000 users / 506,924 transactions / 6,924 fraud tx (1.37% of tx,
2.13% of users) / GNN: 134,764 nodes, 203,112 edges. Chronological 70/15/15
split (fraud), random user split (credit, GNN).

| Model | Test AUC | PR-AUC | F1 | Val AUC | Train time |
|---|---|---|---|---|---|
| fraud v1  | 0.9960 | 0.8985 | 0.478 | 0.9972 | 25s |
| credit v1 | 0.8261 | 0.4702 | 0.461 | 0.8243 | 2s |
| gnn v1    | 0.8440 | 0.4933 | 0.092 | 0.8253 | 10s |

- Serving latency measured over HTTP (200 reqs, uvicorn single worker):
  **p50 0.95ms, p95 1.13ms, p99 1.29ms** — comfortably under the 20ms SLO.
- ONNX/torch parity for fraud: max |Δp| = 5.6e-18. GNN ONNX loads and scores
  the full 134k-node graph in onnxruntime.
- Continuous-training dry run (synthetic fallback, seed 42): reviewer-reject
  label merge added 39,759 noisy positives; challenger dropped to AUC 0.598;
  **correctly NOT promoted** (audit: `ml/jobs/audit/continuous_training.jsonl`).
- A/B router: with a challenger registered, 2,000 users split 1,783 champion /
  217 challenger (10.9%, target 10%).
- Monitoring dry run: PSI/KS flagged 2/14 features (ip_degree, kyc_tier) on a
  time-shifted live window; no performance degradation (live AUC 0.9961 vs
  champion 0.9960).

**Caveat:** these AUCs are against injected fraud with known ground truth;
they validate the plumbing, not real-world efficacy.

## Reproduce

```
pip install pandas pyarrow scikit-learn onnx onnxruntime fastapi uvicorn
python ml/synthetic/generate.py --users 50000 --tx 500000 --seed 42
python -c "from ml.synthetic.features import build_silver, build_gold; \
  f=build_silver(); build_gold(frames={**f, 'edges': __import__('pandas').read_parquet('ml/lakehouse/bronze/edges.parquet')})"
python ml/training/train_fraud.py --version v1
python ml/training/train_credit.py --version v1
python ml/training/train_gnn.py --version v1
python ml/tests/smoke_test.py
python ml/monitoring/drift.py
```
