"""Continuous training job.

1. Ingest: read platform Postgres (POSTGRES_URL / DATABASE_URL; tables
   users, kyc_applications, wallet_transactions) into lakehouse bronze.
   If no DB is reachable, falls back to the synthetic generator and says so.
2. Build silver + gold layers (bronze -> silver -> gold).
3. Merge reviewer-decision labels (kyc_applications.reviewer_decision) into
   fraud labels for KYC-level supervision where available.
4. Retrain the fraud model as a CHALLENGER.
5. Promote only if challenger beats champion by AUC margin.
6. Full audit log (JSON lines) in ml/jobs/audit/.

Run:  python -m ml.jobs.continuous_training  (or python ml/jobs/continuous_training.py)
Cron suggestion: nightly 02:00 WAT (docs/ML.md).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from synthetic import features as feat  # noqa: E402
from synthetic.generate import generate  # noqa: E402
from training import train_fraud  # noqa: E402
from registry import registry  # noqa: E402

AUDIT_DIR = ROOT / "jobs" / "audit"


def _audit(event: str, **kw):
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    rec = {"ts": int(time.time()), "event": event, **kw}
    with (AUDIT_DIR / "continuous_training.jsonl").open("a") as fh:
        fh.write(json.dumps(rec, default=str) + "\n")
    print(f"[ct] {event}: {json.dumps(kw, default=str)[:400]}")


def ingest_from_postgres(lake: Path) -> dict | None:
    """Read production tables into bronze parquet. Returns None if no DB."""
    url = os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL")
    if not url:
        return None
    try:
        import psycopg2  # type: ignore
    except Exception:  # noqa: BLE001
        try:
            import psycopg  # type: ignore  # psycopg3
        except Exception:
            _audit("ingest_skipped", reason="no psycopg driver installed")
            return None
    try:
        if "psycopg2" in sys.modules:
            import psycopg2
            conn = psycopg2.connect(url)
        else:
            import psycopg
            conn = psycopg.connect(url)
        bronze = lake / "bronze"
        bronze.mkdir(parents=True, exist_ok=True)
        out = {}
        queries = {
            "users": 'SELECT id AS user_id, name, "createdAt" AS created_at FROM users',
            "kyc_applications": ('SELECT id AS application_id, "userId" AS user_id, '
                                 'type, status, "kycScore" AS kyc_score, '
                                 '"createdAt" AS created_at, "reviewedAt" AS reviewed_at, '
                                 "formData AS form_data FROM kyc_applications"),
            "wallet_transactions": ('SELECT id AS tx_id, "walletId" AS wallet_id, type, '
                                    '"amountKobo" / 100.0 AS amount_naira, '
                                    '"externalRef" AS external_ref, "createdAt" AS created_at '
                                    "FROM wallet_transactions"),
        }
        for name, q in queries.items():
            df = pd.read_sql_query(q, conn)
            df.to_parquet(bronze / f"{name}.parquet", index=False)
            out[name] = len(df)
        conn.close()
        _audit("ingest_postgres", rows=out)
        return out
    except Exception as e:  # noqa: BLE001
        _audit("ingest_failed", error=f"{type(e).__name__}: {e}")
        return None


def merge_reviewer_labels(lake: Path):
    """Fraud labels from reviewer decisions: rejected KYC + confirmed fraud
    reviews mark the user's transactions as positive training examples."""
    bronze = lake / "bronze"
    kyc_p = bronze / "kyc_applications.parquet"
    tx_p = bronze / "wallet_transactions.parquet"
    if not (kyc_p.exists() and tx_p.exists()):
        return 0
    kyc = pd.read_parquet(kyc_p)
    if "reviewer_decision" not in kyc.columns:
        if "status" in kyc.columns:
            kyc["reviewer_decision"] = np.where(kyc["status"] == "rejected",
                                                "reject", "")
        else:
            return 0
    rejected_users = kyc.loc[kyc["reviewer_decision"] == "reject", "user_id"].unique()
    tx = pd.read_parquet(tx_p)
    if "is_fraud" not in tx.columns:
        tx["is_fraud"] = False
    if "fraud_kind" not in tx.columns:
        tx["fraud_kind"] = ""
    mask = tx["user_id"].isin(rejected_users) & ~tx["is_fraud"]
    tx.loc[mask, "is_fraud"] = True
    tx.loc[mask, "fraud_kind"] = "reviewer_rejected"
    tx.to_parquet(tx_p, index=False)
    n = int(mask.sum())
    _audit("reviewer_labels_merged", new_positive_tx=n,
           rejected_users=int(len(rejected_users)))
    return n


def run(n_users: int = 50_000, n_tx: int = 500_000, seed: int | None = None,
        auc_margin: float = 0.001, epochs: int = 12) -> dict:
    lake = feat.LAKE
    started = time.time()
    _audit("job_start", lake=str(lake))

    ingested = ingest_from_postgres(lake)
    frames = None
    if ingested is None:
        seed = seed if seed is not None else int(time.time()) % 100_000
        _audit("synthetic_fallback", reason="no reachable POSTGRES_URL/DATABASE_URL",
               seed=seed)
        frames = generate(n_users=n_users, n_tx=n_tx, seed=seed)
        # re-read what was written so downstream is identical either way
        frames = None
    merge_reviewer_labels(lake)
    feat.build_silver(lake)
    feat.build_gold(lake)

    # retrain challenger
    result = train_fraud.train(epochs=epochs)
    chal_v = result["version"]
    chal_auc = result["metrics"]["auc"]
    _audit("challenger_trained", version=chal_v, auc=chal_auc,
           metrics=result["metrics"])

    champ = registry.get_champion("fraud")
    promoted = False
    if champ is None:
        registry.set_stage("fraud", chal_v, "champion")
        promoted = True
        reason = "no existing champion"
    elif champ["version"] == chal_v:
        reason = "challenger is champion"
    elif chal_auc >= champ["metrics"].get("auc", -1) + auc_margin:
        registry.promote_challenger("fraud")
        promoted = True
        reason = f"challenger auc {chal_auc:.4f} >= champion {champ['metrics'].get('auc'):.4f} + {auc_margin}"
    else:
        reason = f"challenger auc {chal_auc:.4f} < champion {champ['metrics'].get('auc'):.4f} + {auc_margin}"
    _audit("promotion_decision", promoted=promoted, reason=reason,
           challenger=chal_v, champion=None if champ is None else champ["version"])
    _audit("job_done", seconds=round(time.time() - started, 1),
           promoted=promoted)
    return {"promoted": promoted, "reason": reason, "challenger": chal_v,
            "challenger_auc": chal_auc}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", type=int, default=50_000)
    ap.add_argument("--tx", type=int, default=500_000)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    run(args.users, args.tx, args.seed, epochs=args.epochs)
