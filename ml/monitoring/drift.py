"""Drift + degradation monitoring.

  - PSI (population stability index) per feature between a reference
    (training) distribution and a live window.
  - Two-sample KS statistic per numeric feature (pure numpy, no scipy).
  - Performance degradation: recompute AUC/PR-AUC on labeled live rows and
    compare against the champion's registered metrics.
  - Alerts: JSON written to ml/monitoring/alerts/, printed to console, and
    optionally POSTed to MONITORING_WEBHOOK_URL.

Thresholds (docs/ML.md): PSI > 0.25 significant drift; KS p-proxy via
D_crit = 1.36 * sqrt((n+m)/(n*m)) at alpha=0.05.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ALERT_DIR = ROOT / "monitoring" / "alerts"
sys.path.insert(0, str(ROOT))
from registry import registry  # noqa: E402
from synthetic.features import FRAUD_FEATURES, LAKE  # noqa: E402


def psi(expected: np.ndarray, actual: np.ndarray, bins: int = 10) -> float:
    qs = np.quantile(expected, np.linspace(0, 1, bins + 1))
    qs[0], qs[-1] = -np.inf, np.inf
    qs = np.unique(qs)
    e = np.histogram(expected, qs)[0] / max(len(expected), 1)
    a = np.histogram(actual, qs)[0] / max(len(actual), 1)
    e = np.clip(e, 1e-4, None)
    a = np.clip(a, 1e-4, None)
    return float(np.sum((e - a) * np.log(e / a)))


def ks_statistic(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Two-sample KS D-statistic + critical value at alpha=0.05."""
    x = np.sort(np.asarray(x, dtype=float))
    y = np.sort(np.asarray(y, dtype=float))
    allv = np.concatenate([x, y])
    cdf_x = np.searchsorted(x, allv, side="right") / max(len(x), 1)
    cdf_y = np.searchsorted(y, allv, side="right") / max(len(y), 1)
    d = float(np.max(np.abs(cdf_x - cdf_y)))
    n, m = max(len(x), 1), max(len(y), 1)
    d_crit = 1.36 * np.sqrt((n + m) / (n * m))
    return d, d_crit


def check_feature_drift(reference: pd.DataFrame, live: pd.DataFrame,
                        features: list[str] | None = None,
                        psi_threshold: float = 0.25) -> dict:
    features = features or FRAUD_FEATURES
    report = {"ts": int(time.time()), "features": {}, "drifted": []}
    for f in features:
        if f not in reference or f not in live:
            continue
        ref = reference[f].to_numpy(dtype=float)
        liv = live[f].to_numpy(dtype=float)
        p = psi(ref, liv)
        d, d_crit = ks_statistic(ref, liv)
        flag = p > psi_threshold or d > d_crit
        report["features"][f] = {"psi": round(p, 4), "ks_d": round(d, 4),
                                 "ks_crit": round(d_crit, 4), "drift": bool(flag)}
        if flag:
            report["drifted"].append(f)
    report["n_drifted"] = len(report["drifted"])
    return report


def check_performance(model: str, live: pd.DataFrame, label_col: str = "label",
                      margin: float = 0.05) -> dict:
    """Degradation check vs champion metrics; needs labeled live rows."""
    sys.path.insert(0, str(ROOT))
    from training.common import binary_metrics
    champ = registry.get_champion(model)
    if champ is None:
        return {"model": model, "error": "no champion registered"}
    entry = champ
    adir = Path(entry["artifact_dir"])
    features = entry.get("params", {}).get("features") or FRAUD_FEATURES
    import torch
    ckpt = torch.load(adir / "model.pt", map_location="cpu", weights_only=False)
    from models.fraud_mlp import FraudMLP
    feats = ckpt.get("features", features)
    m = FraudMLP(in_features=len(feats))
    m.load_state_dict(ckpt["state_dict"])
    m.eval()
    X = live[feats].to_numpy(dtype=np.float32)
    with torch.no_grad():
        prob = m(torch.from_numpy(X)).numpy()
    live_metrics = binary_metrics(live[label_col].to_numpy(), prob)
    champ_auc = champ["metrics"].get("auc", float("nan"))
    degraded = bool(live_metrics["auc"] < champ_auc - margin)
    return {"model": model, "champion_version": champ["version"],
            "champion_auc": champ_auc, "live_auc": live_metrics["auc"],
            "margin": margin, "degraded": degraded}


def emit_alert(kind: str, payload: dict):
    ALERT_DIR.mkdir(parents=True, exist_ok=True)
    rec = {"ts": int(time.time()), "kind": kind, **payload}
    f = ALERT_DIR / f"alert-{int(time.time())}-{kind}.json"
    f.write_text(json.dumps(rec, indent=2))
    print(f"[ALERT:{kind}] {json.dumps(payload)}")
    url = os.environ.get("MONITORING_WEBHOOK_URL")
    if url:
        try:
            req = urllib.request.Request(
                url, data=json.dumps(rec).encode(),
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:  # noqa: BLE001
            print(f"[monitoring] webhook delivery failed: {e}")
    return rec


def run_monitoring(live_path: str | None = None, model: str = "fraud") -> dict:
    """Full monitoring pass: drift + degradation vs champion. Emits alerts."""
    gold = LAKE / "gold" / "fraud_training.parquet"
    reference = pd.read_parquet(gold)
    live = pd.read_parquet(live_path) if live_path else reference.tail(50_000)
    drift_report = check_feature_drift(reference, live)
    result = {"drift": drift_report}
    if drift_report["n_drifted"] > 0:
        emit_alert("feature_drift", {"model": model,
                                     "drifted": drift_report["drifted"],
                                     "n_drifted": drift_report["n_drifted"]})
    if "label" in live.columns:
        perf = check_performance(model, live)
        result["performance"] = perf
        if perf.get("degraded"):
            emit_alert("performance_degradation", perf)
    return result


if __name__ == "__main__":
    print(json.dumps(run_monitoring(), indent=2, default=str))
