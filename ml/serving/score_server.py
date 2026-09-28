"""CPU inference server (FastAPI).

Loads champion models from the registry at startup. Fraud/credit run through
ONNX Runtime when the `onnx`/`onnxruntime` packages are importable and a
model.onnx artifact exists, else through torch. The GNN runs through torch
full-graph inference on a supplied subgraph.

Endpoints:
  POST /score/fraud   {features: {name: value, ...}}        -> {probability}
  POST /score/credit  {features: {...}}                     -> {p_default, credit_limit_naira}
  POST /score/gnn     {x: [[..]], edge_src: [..], edge_dst: [..], node_index: i}
                                                            -> {probability}
  GET  /healthz       model/version/backend info

Latency: batch-1 CPU inference of these tiny MLPs is sub-millisecond in
ONNX Runtime; p95 < 20ms is the documented SLO (see docs/ML.md).

Run:  ML_SCORING_PORT=8090 uvicorn ml.serving.score_server:app
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from registry import registry  # noqa: E402
from synthetic.features import CREDIT_FEATURES, FRAUD_FEATURES  # noqa: E402
from models.credit_mlp import CreditMLP, pd_to_credit_limit  # noqa: E402
from models.fraud_mlp import FraudMLP  # noqa: E402
from models.graphsage import GraphSAGE  # noqa: E402

try:
    import onnxruntime as ort  # type: ignore
    _HAS_ORT = True
except Exception:  # noqa: BLE001
    ort = None
    _HAS_ORT = False

try:
    from fastapi import FastAPI
    from pydantic import BaseModel
except Exception as e:  # noqa: BLE001
    raise SystemExit(f"fastapi required for score_server: {e}")

app = FastAPI(title="NigeriaPass ML Scoring", version="1.0.0")
_STATE: dict = {"latency_ms": {}}


def _load_tabular(model_name: str, cls, features: list[str]):
    champ = registry.get_champion(model_name)
    if champ is None:
        return None
    adir = Path(champ["artifact_dir"])
    onnx_path = adir / "model.onnx"
    if _HAS_ORT and onnx_path.exists():
        sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        return {"backend": "onnxruntime", "version": champ["version"],
                "features": features,
                "predict": lambda x: sess.run(
                    None, {"features": x.astype(np.float32)})[0].reshape(-1)}
    ckpt = torch.load(adir / "model.pt", map_location="cpu", weights_only=False)
    m = cls(in_features=len(features))
    m.load_state_dict(ckpt["state_dict"])
    m.eval()
    return {"backend": "torch", "version": champ["version"],
            "features": features,
            "predict": lambda x: m(torch.from_numpy(x.astype(np.float32)))
            .detach().numpy().reshape(-1)}


def _load_gnn():
    champ = registry.get_champion("gnn")
    if champ is None:
        return None
    adir = Path(champ["artifact_dir"])
    ckpt = torch.load(adir / "model.pt", map_location="cpu", weights_only=False)
    m = GraphSAGE(in_dim=6, hidden=ckpt["params"]["hidden"], num_layers=2)
    m.load_state_dict(ckpt["state_dict"])
    m.eval()
    return {"backend": "torch", "version": champ["version"], "model": m}


@app.on_event("startup")
def _startup():
    _STATE["fraud"] = _load_tabular("fraud", FraudMLP, FRAUD_FEATURES)
    _STATE["credit"] = _load_tabular("credit", CreditMLP, CREDIT_FEATURES)
    _STATE["gnn"] = _load_gnn()


def reload_models():
    _startup()
    return {"fraud": _ver("fraud"), "credit": _ver("credit"), "gnn": _ver("gnn")}


def _ver(name):
    e = _STATE.get(name)
    return None if e is None else {"version": e["version"], "backend": e["backend"]}


class FeatureRequest(BaseModel):
    features: dict


class GnnRequest(BaseModel):
    x: list[list[float]]
    edge_src: list[int]
    edge_dst: list[int]
    node_index: int = 0


def _score_tabular(name: str, feats: dict) -> float:
    entry = _STATE.get(name)
    if entry is None:
        raise KeyError(f"model '{name}' not loaded (train + register first)")
    x = np.array([[feats.get(f, 0.0) for f in entry["features"]]], dtype=np.float32)
    t0 = time.perf_counter()
    p = float(entry["predict"](x)[0])
    _STATE["latency_ms"].setdefault(name, []).append(
        round((time.perf_counter() - t0) * 1000, 3))
    return p


@app.get("/healthz")
def healthz():
    lat = {k: (max(v[-500:]) if v else None)
           for k, v in _STATE["latency_ms"].items()}
    return {"fraud": _ver("fraud"), "credit": _ver("credit"), "gnn": _ver("gnn"),
            "max_latency_ms_recent": lat}


@app.post("/reload")
def reload_ep():
    return reload_models()


@app.post("/score/fraud")
def score_fraud(req: FeatureRequest):
    p = _score_tabular("fraud", req.features)
    return {"model": "fraud", "version": _ver("fraud"), "fraud_probability": p,
            "decision": "block" if p >= 0.8 else "review" if p >= 0.5 else "allow"}


@app.post("/score/credit")
def score_credit(req: FeatureRequest):
    p = _score_tabular("credit", req.features)
    tier = int(req.features.get("kyc_tier", 1))
    return {"model": "credit", "version": _ver("credit"), "p_default": p,
            "credit_limit_naira": pd_to_credit_limit(p, tier)}


@app.post("/score/gnn")
def score_gnn(req: GnnRequest):
    entry = _STATE.get("gnn")
    if entry is None:
        raise KeyError("model 'gnn' not loaded (train + register first)")
    m: GraphSAGE = entry["model"]
    x = torch.tensor(req.x, dtype=torch.float32)
    es = torch.tensor(req.edge_src, dtype=torch.long)
    ed = torch.tensor(req.edge_dst, dtype=torch.long)
    t0 = time.perf_counter()
    with torch.no_grad():
        probs = torch.sigmoid(m.full_forward(x, es, ed))
    _STATE["latency_ms"].setdefault("gnn", []).append(
        round((time.perf_counter() - t0) * 1000, 3))
    return {"model": "gnn", "version": _ver("gnn"),
            "fraud_probability": float(probs[req.node_index])}


if __name__ == "__main__":
    import os
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ML_SCORING_PORT", "8090")))
