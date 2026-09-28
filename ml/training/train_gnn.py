"""Train the pure-torch GraphSAGE fraud-ring detector from gold graph parquet.

Semi-supervised: only user nodes carry labels (mule-ring / collusion members
are positive). Mini-batch neighbor sampling (fanouts 10,10), class-weighted
BCE, early stopping on val AUC. Saves model.pt and attempts ONNX export of
the full-graph forward (opset 17); if ONNX export fails the .pt remains the
serving artifact (documented in docs/ML.md).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from synthetic.features import LAKE  # noqa: E402
from models.graphsage import GraphSAGE, NeighborSampler  # noqa: E402
from training.common import EarlyStopper, binary_metrics  # noqa: E402
from registry import registry  # noqa: E402
from training.common import ARTIFACTS  # noqa: E402


def train(hidden: int = 32, epochs: int = 20, lr: float = 5e-3,
          batch: int = 1024, fanouts=(10, 10), seed: int = 42,
          version: str | None = None, patience: int = 5) -> dict:
    import pandas as pd
    torch.manual_seed(seed)
    np.random.seed(seed)
    gold = LAKE / "gold"
    x = torch.from_numpy(np.load(gold / "gnn_x.npy"))
    edges = pd.read_parquet(gold / "gnn_edges.parquet")
    labels = pd.read_parquet(gold / "gnn_labels.parquet")
    nodes = pd.read_parquet(gold / "gnn_nodes.parquet")
    y = labels.sort_values("node_id")["label"].to_numpy()
    es = edges["src"].to_numpy()
    ed = edges["dst"].to_numpy()
    n_nodes = len(nodes)

    labeled = np.where(y >= 0)[0]
    user_mask = nodes.sort_values("node_id")["kind"].to_numpy() == "user"
    assert len(labeled) == user_mask.sum()
    rng = np.random.default_rng(seed)
    perm = rng.permutation(labeled)
    n = len(perm)
    i_tr, i_va, i_te = perm[: int(n * .7)], perm[int(n * .7): int(n * .85)], perm[int(n * .85):]
    print(f"[gnn] nodes={n_nodes} edges={len(es)} labeled={n} "
          f"fraud_rate={y[labeled].mean():.3%}")

    sampler = NeighborSampler(es, ed, n_nodes, seed=seed)
    model = GraphSAGE(in_dim=x.shape[1], hidden=hidden, num_layers=2)
    pos = y[i_tr].sum()
    pos_weight = torch.tensor((len(i_tr) - pos) / max(pos, 1.0), dtype=torch.float32)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    opt = torch.optim.Adam(model.parameters(), lr=lr)

    def infer(nodes_idx: np.ndarray) -> np.ndarray:
        """Mini-batch neighbor-sampled inference."""
        model.eval()
        probs = []
        with torch.no_grad():
            for s in range(0, len(nodes_idx), 4096):
                seeds = nodes_idx[s: s + 4096]
                xb, blocks, seed_local = sampler.sample_blocks(seeds, list(fanouts), x)
                logits = model.forward_blocks(xb, blocks)
                probs.append(torch.sigmoid(logits[seed_local]).numpy())
        return np.concatenate(probs)

    stopper = EarlyStopper(patience=patience)
    t0 = time.time()
    for ep in range(1, epochs + 1):
        model.train()
        perm_ep = rng.permutation(i_tr)
        tot = 0.0
        for s in range(0, len(perm_ep), batch):
            seeds = perm_ep[s: s + batch]
            xb, blocks, seed_local = sampler.sample_blocks(seeds, list(fanouts), x)
            logits = model.forward_blocks(xb, blocks)[seed_local]
            tgt = torch.from_numpy(y[seeds].astype(np.float32))
            loss = loss_fn(logits, tgt)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(seeds)
        va_auc = binary_metrics(y[i_va], infer(i_va))["auc"]
        print(f"[gnn] epoch {ep:02d} loss={tot/len(perm_ep):.4f} val_auc={va_auc:.4f}")
        if stopper.step(va_auc, model):
            print(f"[gnn] early stop at epoch {ep}")
            break
    if stopper.best_state:
        model.load_state_dict(stopper.best_state)

    metrics = binary_metrics(y[i_te], infer(i_te))
    metrics["val_auc"] = float(stopper.best)
    metrics["train_seconds"] = round(time.time() - t0, 1)
    print(f"[gnn] TEST: {metrics}")

    version = version or time.strftime("v%Y%m%d%H%M%S")
    out = ARTIFACTS / "gnn" / version
    out.mkdir(parents=True, exist_ok=True)
    model.eval()
    torch.save({"state_dict": model.state_dict(),
                "params": {"hidden": hidden, "epochs": epochs, "lr": lr,
                           "fanouts": list(fanouts), "seed": seed},
                "metrics": metrics}, out / "model.pt")
    onnx_ok, onnx_err = True, ""
    try:
        wrapped = _OnnxWrapper(model)
        torch.onnx.export(
            wrapped, (x, torch.from_numpy(es), torch.from_numpy(ed)),
            str(out / "model.onnx"),
            input_names=["x", "edge_src", "edge_dst"], output_names=["logits"],
            dynamic_axes={"x": {0: "nodes"}, "edge_src": {0: "edges"},
                          "edge_dst": {0: "edges"}, "logits": {0: "nodes"}},
            opset_version=17)
    except Exception as e:  # noqa: BLE001
        onnx_ok, onnx_err = False, f"{type(e).__name__}: {e}"
        print(f"[gnn] ONNX export skipped: {onnx_err}")
    meta = {"model": "gnn", "version": version, "metrics": metrics,
            "params": {"hidden": hidden, "epochs": epochs, "lr": lr,
                       "fanouts": list(fanouts), "seed": seed},
            "onnx_exported": onnx_ok,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if not onnx_ok:
        meta["onnx_error"] = onnx_err
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    registry.log_run("gnn", version, meta["params"], metrics, str(out))
    return {"version": version, "metrics": metrics, "artifact_dir": str(out)}


class _OnnxWrapper(nn.Module):
    """sigmoid probabilities over the full graph, ONNX-friendly signature."""

    def __init__(self, model: GraphSAGE):
        super().__init__()
        self.model = model

    def forward(self, x, edge_src, edge_dst):
        return torch.sigmoid(self.model.full_forward(x, edge_src, edge_dst))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hidden", type=int, default=32)
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--lr", type=float, default=5e-3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--version", type=str, default=None)
    args = ap.parse_args()
    train(hidden=args.hidden, epochs=args.epochs, lr=args.lr, seed=args.seed,
          version=args.version)
