"""Smoke test: load every champion artifact and score a sample.

Exits non-zero if any model is missing, fails to load, or produces
out-of-range probabilities. Run after training:
    python ml/tests/smoke_test.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from registry import registry  # noqa: E402
from synthetic.features import CREDIT_FEATURES, FRAUD_FEATURES  # noqa: E402

try:
    import onnxruntime as ort
    _HAS_ORT = True
except Exception:  # noqa: BLE001
    ort = None
    _HAS_ORT = False


def _load_pt(adir: Path):
    return torch.load(adir / "model.pt", map_location="cpu", weights_only=False)


def score_tabular(model_name: str, cls, features: list[str], sample: dict) -> float:
    champ = registry.get_champion(model_name)
    assert champ, f"no champion registered for {model_name}"
    adir = Path(champ["artifact_dir"])
    x = np.array([[sample.get(f, 0.0) for f in features]], dtype=np.float32)
    onnx_path = adir / "model.onnx"
    if _HAS_ORT and onnx_path.exists():
        sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        p = float(sess.run(None, {"features": x})[0].reshape(-1)[0])
        backend = "onnxruntime"
    else:
        ckpt = _load_pt(adir)
        m = cls(in_features=len(features))
        m.load_state_dict(ckpt["state_dict"])
        m.eval()
        with torch.no_grad():
            p = float(m(torch.from_numpy(x))[0])
        backend = "torch"
    assert 0.0 <= p <= 1.0, f"{model_name} probability out of range: {p}"
    print(f"[smoke] {model_name} v{champ['version']} ({backend}) -> p={p:.4f}")
    return p


def main() -> int:
    from models.fraud_mlp import FraudMLP
    from models.credit_mlp import CreditMLP
    from models.graphsage import GraphSAGE

    fraud_sample = {f: 0.0 for f in FRAUD_FEATURES}
    fraud_sample.update({"amount_log": 9.0, "amount_z": 3.0, "tx_count_1h": 12,
                         "tx_count_24h": 25, "device_degree": 5, "ip_degree": 6,
                         "kyc_tier": 1, "is_night": 1, "is_transfer": 1})
    score_tabular("fraud", FraudMLP, FRAUD_FEATURES, fraud_sample)

    credit_sample = {f: 0.0 for f in CREDIT_FEATURES}
    credit_sample.update({"account_age_days": 200, "tx_count_30d": 40,
                          "topup_count_30d": 8, "avg_topup_amount_log": 8.5,
                          "kyc_tier": 2, "kyc_score": 70})
    score_tabular("credit", CreditMLP, CREDIT_FEATURES, credit_sample)

    champ = registry.get_champion("gnn")
    assert champ, "no champion registered for gnn"
    ckpt = _load_pt(Path(champ["artifact_dir"]))
    m = GraphSAGE(in_dim=6, hidden=ckpt["params"]["hidden"], num_layers=2)
    m.load_state_dict(ckpt["state_dict"])
    m.eval()
    # tiny 3-node graph: user -- device -- user
    x = torch.tensor([[1, 0, 0, 0.3, 0.5, 0.2],
                      [0, 1, 0, 0.0, 0.7, 0.0],
                      [1, 0, 0, 0.3, 0.5, 0.2]], dtype=torch.float32)
    es = torch.tensor([0, 2, 1, 1], dtype=torch.long)
    ed = torch.tensor([1, 1, 0, 2], dtype=torch.long)
    with torch.no_grad():
        probs = torch.sigmoid(m.full_forward(x, es, ed))
    assert torch.all((probs >= 0) & (probs <= 1))
    print(f"[smoke] gnn v{champ['version']} (torch) -> p={probs.tolist()}")
    print("[smoke] ALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
