"""Parallel feature engineering + hyperparameter sweep.

Uses Ray (ray.data + ray.remote tasks) when the `ray` package is importable;
honours RAY_ADDRESS for attaching to an existing cluster. Falls back to an
identical local (single-process) implementation otherwise, so CI and
developer laptops work with zero Ray dependency.

Env:
  RAY_ADDRESS=ray://head:10001   attach to cluster (default: local ray.init)
"""
from __future__ import annotations

import itertools
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import ray  # type: ignore
    _HAS_RAY = True
except Exception:  # noqa: BLE001
    ray = None
    _HAS_RAY = False


def _init_ray():
    addr = os.environ.get("RAY_ADDRESS")
    if not ray.is_initialized():
        ray.init(address=addr, ignore_reinit_error=True,
                 log_to_driver=False, include_dashboard=False)


# ------------------------------------------------------------------ tasks
def _velocity_chunk(args) -> pd.DataFrame:
    """Feature-engineering task over a chunk of enriched transactions.
    Kept deliberately pure so it can be a Ray remote task or a local call."""
    df, = args
    return df  # enrichment already done in silver; hook for extra per-chunk work


def _train_fraud_cfg(cfg: dict) -> dict:
    from training.train_fraud import train
    return train(hidden=cfg["hidden"], lr=cfg["lr"], epochs=cfg.get("epochs", 12),
                 seed=cfg.get("seed", 42), version=None)


def hyperparameter_sweep(grid: dict | None = None, use_ray: bool | None = None) -> list[dict]:
    """Grid sweep over fraud model hyperparameters. Ray-parallel when
    available, sequential local fallback otherwise. Returns run summaries."""
    grid = grid or {"hidden": [32, 64], "lr": [1e-3, 3e-3]}
    cfgs = [dict(zip(grid.keys(), v))
            for v in itertools.product(*grid.values())]
    if use_ray is None:
        use_ray = _HAS_RAY
    if use_ray and _HAS_RAY:
        _init_ray()
        remote = ray.remote(num_cpus=1)(_train_fraud_cfg)
        results = ray.get([remote.remote(c) for c in cfgs])
    else:
        if use_ray and not _HAS_RAY:
            print("[pipeline] ray requested but not importable; local fallback")
        results = [_train_fraud_cfg(c) for c in cfgs]
    best = max(results, key=lambda r: r["metrics"].get("auc", 0))
    print(f"[pipeline] sweep done; best auc={best['metrics'].get('auc'):.4f} "
          f"params={best.get('artifact_dir')}")
    return results


def parallel_feature_check(lake: Path | None = None) -> dict:
    """Ray-parallel (or local) sanity pass over silver partitions: returns
    row counts + fraud rates, one remote task per chunk."""
    from synthetic.features import LAKE
    lake = lake or LAKE
    df = pd.read_parquet(lake / "silver" / "transactions_enriched.parquet",
                         columns=["user_id", "is_fraud", "amount_naira"])
    chunks = np.array_split(df, 8)

    def summarize(c: pd.DataFrame) -> dict:
        return {"rows": int(len(c)), "fraud_rate": float(c["is_fraud"].mean()),
                "median_amount": float(c["amount_naira"].median())}

    if _HAS_RAY:
        _init_ray()
        remote = ray.remote(num_cpus=1)(summarize)
        parts = ray.get([remote.remote(c) for c in chunks])
    else:
        parts = [summarize(c) for c in chunks]
    return {"backend": "ray" if _HAS_RAY else "local", "chunks": parts}


if __name__ == "__main__":
    print(parallel_feature_check())
    hyperparameter_sweep()
