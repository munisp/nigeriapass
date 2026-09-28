"""Shared training utilities: metrics, splits, early stopping, ONNX export."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import (average_precision_score, confusion_matrix, f1_score,
                             roc_auc_score)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"


def time_split(df, label_col="label", ts_col="created_at",
               train_frac=0.7, val_frac=0.15):
    """Chronological split (no leakage from future into training)."""
    ts = df[ts_col].to_numpy() if ts_col in df else np.arange(len(df))
    order = np.argsort(ts, kind="stable")
    n = len(df)
    i_tr = order[: int(n * train_frac)]
    i_va = order[int(n * train_frac): int(n * (train_frac + val_frac))]
    i_te = order[int(n * (train_frac + val_frac)):]
    return i_tr, i_va, i_te


def random_split(n, seed=42, train_frac=0.7, val_frac=0.15):
    rng = np.random.default_rng(seed)
    perm = rng.permutation(n)
    return (perm[: int(n * train_frac)],
            perm[int(n * train_frac): int(n * (train_frac + val_frac))],
            perm[int(n * (train_frac + val_frac)):])


def binary_metrics(y_true, y_prob) -> dict:
    y_true = np.asarray(y_true).astype(int)
    y_prob = np.asarray(y_prob).astype(float)
    out = {}
    if len(np.unique(y_true)) > 1:
        out["auc"] = float(roc_auc_score(y_true, y_prob))
        out["pr_auc"] = float(average_precision_score(y_true, y_prob))
    else:
        out["auc"] = out["pr_auc"] = float("nan")
    y_pred = (y_prob >= 0.5).astype(int)
    out["f1"] = float(f1_score(y_true, y_pred, zero_division=0))
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    out["confusion"] = {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}
    out["base_rate"] = float(y_true.mean())
    return out


class EarlyStopper:
    def __init__(self, patience=5, min_delta=1e-4):
        self.patience, self.min_delta = patience, min_delta
        self.best = -np.inf
        self.bad = 0
        self.best_state = None

    def step(self, metric, model) -> bool:
        if metric > self.best + self.min_delta:
            self.best = metric
            self.bad = 0
            self.best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            return False
        self.bad += 1
        return self.bad >= self.patience


def save_artifacts(model, model_name: str, version: str, sample_input: torch.Tensor,
                   metrics: dict, params: dict, feature_names: list[str],
                   extra: dict | None = None) -> Path:
    """Save model.pt + model.onnx (opset 17) + meta.json under artifacts/<name>/<version>/."""
    out = ARTIFACTS / model_name / version
    out.mkdir(parents=True, exist_ok=True)
    model.eval()
    torch.save({"state_dict": model.state_dict(), "params": params,
                "metrics": metrics, "features": feature_names}, out / "model.pt")
    onnx_ok, onnx_err = True, ""
    try:
        torch.onnx.export(
            model, (sample_input,), str(out / "model.onnx"),
            input_names=["features"], output_names=["probability"],
            dynamic_axes={"features": {0: "batch"}, "probability": {0: "batch"}},
            opset_version=17)
    except Exception as e:  # noqa: BLE001 - ONNX export must never break training
        onnx_ok, onnx_err = False, f"{type(e).__name__}: {e}"
    meta = {"model": model_name, "version": version,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "metrics": metrics, "params": params, "features": feature_names,
            "onnx_exported": onnx_ok, **(extra or {})}
    if not onnx_ok:
        meta["onnx_error"] = onnx_err
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    return out
