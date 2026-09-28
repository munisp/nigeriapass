"""Model registry: MLflow when MLFLOW_TRACKING_URI is set (and mlflow
importable), else a file-based registry under ml/registry/store/.

File-based layout:
  store/<model>/registry.json -> {"model": ..., "champion": v, "challenger": v|None,
      "versions": [{version, created_at, metrics, params, artifact_dir}]}

API:
  log_run(model, version, params, metrics, artifact_dir)
  set_stage(model, version, stage)   stage in {"champion", "challenger", "archived"}
  get_champion(model) / get_challenger(model) -> version dict | None
  promote_challenger(model) -> bool
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / "registry" / "store"


def _mlflow():
    uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not uri:
        return None
    try:
        import mlflow  # type: ignore
        mlflow.set_tracking_uri(uri)
        return mlflow
    except Exception as e:  # noqa: BLE001
        print(f"[registry] MLFLOW_TRACKING_URI set but mlflow unusable ({e}); "
              "falling back to file registry")
        return None


def _path(model: str) -> Path:
    p = STORE / model
    p.mkdir(parents=True, exist_ok=True)
    return p / "registry.json"


def _load(model: str) -> dict:
    p = _path(model)
    if p.exists():
        return json.loads(p.read_text())
    return {"model": model, "champion": None, "challenger": None, "versions": []}


def _save(model: str, data: dict):
    _path(model).write_text(json.dumps(data, indent=2))


def log_run(model: str, version: str, params: dict, metrics: dict,
            artifact_dir: str) -> dict:
    """Record a trained version. First version becomes champion automatically."""
    ml = _mlflow()
    if ml is not None:
        try:
            with ml.start_run(run_name=f"{model}-{version}"):
                ml.log_params({k: str(v) for k, v in params.items()})
                ml.log_metrics({k: float(v) for k, v in metrics.items()
                                if isinstance(v, (int, float)) and v == v})
                ml.log_artifacts(artifact_dir)
        except Exception as e:  # noqa: BLE001
            print(f"[registry] mlflow logging failed ({e}); continuing file-based")
    data = _load(model)
    data["versions"] = [v for v in data["versions"] if v["version"] != version]
    entry = {"version": version,
             "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "metrics": metrics, "params": params, "artifact_dir": str(artifact_dir)}
    data["versions"].append(entry)
    if data["champion"] is None:
        data["champion"] = version
        entry["stage"] = "champion"
    else:
        data["challenger"] = version
        entry["stage"] = "challenger"
    _save(model, data)
    print(f"[registry] {model} v{version} logged (stage={entry['stage']})")
    return entry


def set_stage(model: str, version: str, stage: str) -> bool:
    data = _load(model)
    found = False
    for v in data["versions"]:
        if v["version"] == version:
            v["stage"] = stage
            found = True
        elif v.get("stage") == stage and stage in ("champion", "challenger"):
            v["stage"] = "archived"
    if not found:
        return False
    if stage == "champion":
        data["champion"] = version
        if data.get("challenger") == version:
            data["challenger"] = None
    elif stage == "challenger":
        data["challenger"] = version
    _save(model, data)
    return True


def get_version(model: str, version: str) -> dict | None:
    for v in _load(model)["versions"]:
        if v["version"] == version:
            return v
    return None


def get_champion(model: str) -> dict | None:
    data = _load(model)
    return get_version(model, data["champion"]) if data.get("champion") else None


def get_challenger(model: str) -> dict | None:
    data = _load(model)
    return get_version(model, data["challenger"]) if data.get("challenger") else None


def promote_challenger(model: str) -> bool:
    data = _load(model)
    ch = data.get("challenger")
    if not ch:
        return False
    return set_stage(model, ch, "champion")
