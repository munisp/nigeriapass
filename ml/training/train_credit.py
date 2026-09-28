"""Train the fleet credit-limit scorer (CreditMLP) from gold parquet.

Random user-level split (iid users), class-weighted BCE, early stopping on
val AUC, metrics logged to the registry, weights + ONNX saved.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from synthetic.features import CREDIT_FEATURES, LAKE  # noqa: E402
from models.credit_mlp import CreditMLP  # noqa: E402
from training.common import (EarlyStopper, binary_metrics, random_split,  # noqa: E402
                             save_artifacts)
from registry import registry  # noqa: E402


def train(gold_path: Path | None = None, hidden: int = 64, epochs: int = 30,
          lr: float = 1e-3, batch: int = 2048, seed: int = 42,
          version: str | None = None, patience: int = 5) -> dict:
    import pandas as pd
    torch.manual_seed(seed)
    np.random.seed(seed)
    df = pd.read_parquet(gold_path or (LAKE / "gold" / "credit_training.parquet"))
    X = df[CREDIT_FEATURES].to_numpy(dtype=np.float32)
    y = df["label"].to_numpy(dtype=np.float32)
    i_tr, i_va, i_te = random_split(len(df), seed=seed)
    print(f"[credit] rows={len(df)} default_rate={y.mean():.3%} "
          f"split={len(i_tr)}/{len(i_va)}/{len(i_te)}")

    model = CreditMLP(in_features=X.shape[1], hidden=hidden)
    model.set_scaler(X[i_tr].mean(0), X[i_tr].std(0))

    pos = y[i_tr].sum()
    pos_weight = torch.tensor((len(i_tr) - pos) / max(pos, 1.0), dtype=torch.float32)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    Xtr = torch.from_numpy(X[i_tr]); ytr = torch.from_numpy(y[i_tr])
    Xva = torch.from_numpy(X[i_va]); yva = y[i_va]
    stopper = EarlyStopper(patience=patience)
    t0 = time.time()
    for ep in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(len(Xtr))
        tot = 0.0
        for s in range(0, len(Xtr), batch):
            idx = perm[s: s + batch]
            opt.zero_grad()
            loss = loss_fn(model.logits(Xtr[idx]), ytr[idx])
            loss.backward()
            opt.step()
            tot += loss.item() * len(idx)
        model.eval()
        with torch.no_grad():
            va_auc = binary_metrics(yva, model(Xva).numpy())["auc"]
        print(f"[credit] epoch {ep:02d} loss={tot/len(Xtr):.4f} val_auc={va_auc:.4f}")
        if stopper.step(va_auc, model):
            print(f"[credit] early stop at epoch {ep}")
            break
    if stopper.best_state:
        model.load_state_dict(stopper.best_state)

    model.eval()
    with torch.no_grad():
        metrics = binary_metrics(y[i_te], model(torch.from_numpy(X[i_te])).numpy())
    metrics["val_auc"] = float(stopper.best)
    metrics["train_seconds"] = round(time.time() - t0, 1)
    print(f"[credit] TEST: {metrics}")

    version = version or time.strftime("v%Y%m%d%H%M%S")
    params = {"hidden": hidden, "epochs": epochs, "lr": lr, "batch": batch,
              "seed": seed, "n_train": len(i_tr)}
    out = save_artifacts(model, "credit", version,
                         torch.from_numpy(X[i_te][:8]), metrics, params,
                         CREDIT_FEATURES)
    registry.log_run("credit", version, params, metrics, str(out))
    return {"version": version, "metrics": metrics, "artifact_dir": str(out)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--version", type=str, default=None)
    args = ap.parse_args()
    train(hidden=args.hidden, epochs=args.epochs, lr=args.lr, seed=args.seed,
          version=args.version)
