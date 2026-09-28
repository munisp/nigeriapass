"""Silver + Gold layer builders: feature engineering from bronze parquet.

Silver: typed/enriched transaction rows with velocity & sharing features.
Gold:  model-ready tables
  - fraud_training.parquet    (tx-level features + label)
  - credit_training.parquet   (user-level features + default label)
  - gnn_nodes.parquet / gnn_edges.parquet / gnn_labels.parquet

FRAUD_FEATURES is the canonical fraud feature schema, shared by training,
serving (score_server.py) and the Node bridge (server/ml/features.ts).
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
LAKE = ROOT / "lakehouse"

FRAUD_FEATURES = [
    "amount_log",          # log1p(amount_naira)
    "amount_z",            # z-score vs user's own history
    "tx_count_1h",         # velocity: txs by this user in trailing 1h
    "tx_count_24h",        # velocity: txs in trailing 24h
    "device_degree",       # #users sharing this device
    "ip_degree",           # #users sharing this IP
    "kyc_age_days",        # days since KYC application
    "kyc_tier",            # 1..3
    "hour_sin", "hour_cos",  # time-of-day cyclical
    "is_night",            # 0-6h WAT
    "days_since_signup",
    "is_transfer", "is_topup",
]

CREDIT_FEATURES = [
    "account_age_days", "tx_count_30d", "topup_count_30d",
    "avg_topup_amount_log", "toll_spend_30d_log", "avg_balance_proxy_log",
    "balance_volatility", "kyc_tier", "kyc_score", "has_chargeback",
]


def build_silver(lake: Path | None = None, frames: dict | None = None) -> dict:
    lake = lake or LAKE
    bronze, silver = lake / "bronze", lake / "silver"
    silver.mkdir(parents=True, exist_ok=True)
    if frames is None:
        users = pd.read_parquet(bronze / "users.parquet")
        kyc = pd.read_parquet(bronze / "kyc_applications.parquet")
        tx = pd.read_parquet(bronze / "wallet_transactions.parquet")
    else:
        users, kyc, tx = frames["users"], frames["kyc"], frames["tx"]
    t0 = time.time()

    tx = tx.sort_values(["user_id", "created_at", "tx_id"]).reset_index(drop=True)

    # trailing velocity counts via searchsorted on per-user sorted timestamps
    ts = tx["created_at"].to_numpy()
    u = tx["user_id"].to_numpy()
    order_groups = pd.Series(u).ne(pd.Series(u).shift()).cumsum().to_numpy()
    # compute per-user start offsets
    starts = np.flatnonzero(np.r_[True, u[1:] != u[:-1]])
    ends = np.r_[starts[1:], len(u)]
    c1h = np.empty(len(tx), dtype=np.int32)
    c24h = np.empty(len(tx), dtype=np.int32)
    for s, e in zip(starts, ends):
        seg = ts[s:e]
        c1h[s:e] = np.arange(e - s) - np.searchsorted(seg, seg - 3600, side="left") + 1
        c24h[s:e] = np.arange(e - s) - np.searchsorted(seg, seg - 86400, side="left") + 1
    tx["tx_count_1h"] = c1h
    tx["tx_count_24h"] = c24h

    # per-user amount stats -> z-score
    g = tx.groupby("user_id")["amount_naira"]
    mu = g.transform("mean")
    sd = g.transform("std").fillna(1.0).clip(lower=1.0)
    tx["amount_z"] = ((tx["amount_naira"] - mu) / sd).clip(-8, 8)

    # sharing degrees
    dev_deg = users.groupby("device_id")["user_id"].count()
    ip_deg = users.groupby("ip")["user_id"].count()
    tx["device_degree"] = tx["device_id"].map(dev_deg).fillna(1).astype(np.int32)
    tx["ip_degree"] = tx["ip"].map(ip_deg).fillna(1).astype(np.int32)

    # user-level joins
    umap = users.set_index("user_id")
    tx["kyc_tier"] = umap["kyc_tier"].reindex(tx["user_id"]).to_numpy()
    signup = umap["created_at"].reindex(tx["user_id"]).to_numpy()
    tx["days_since_signup"] = ((tx["created_at"] - signup) / 86400).clip(lower=0)
    kmap = kyc.set_index("user_id")
    kcreated = kmap["created_at"].reindex(tx["user_id"]).to_numpy()
    tx["kyc_age_days"] = ((tx["created_at"] - kcreated) / 86400).clip(lower=0)

    hour = (tx["created_at"] // 3600) % 24
    tx["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    tx["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    tx["is_night"] = ((hour < 6) | (hour >= 23)).astype(np.int8)
    tx["amount_log"] = np.log1p(tx["amount_naira"])
    tx["is_transfer"] = (tx["type"] == "transfer").astype(np.int8)
    tx["is_topup"] = (tx["type"] == "topup").astype(np.int8)

    tx.to_parquet(silver / "transactions_enriched.parquet", index=False)
    users.to_parquet(silver / "users_enriched.parquet", index=False)
    print(f"[silver] {len(tx)} enriched txs in {time.time()-t0:.1f}s")
    return {"tx": tx, "users": users, "kyc": kyc}


def build_gold(lake: Path | None = None, frames: dict | None = None,
               seed: int = 42) -> dict:
    lake = lake or LAKE
    silver, gold = lake / "silver", lake / "gold"
    gold.mkdir(parents=True, exist_ok=True)
    if frames is None:
        tx = pd.read_parquet(silver / "transactions_enriched.parquet")
        users = pd.read_parquet(silver / "users_enriched.parquet")
        kyc = pd.read_parquet(lake / "bronze" / "kyc_applications.parquet")
        edges = pd.read_parquet(lake / "bronze" / "edges.parquet")
    else:
        tx, users, kyc, edges = frames["tx"], frames["users"], frames["kyc"], frames["edges"]
    t0 = time.time()

    # ---- fraud training table
    fraud = tx[FRAUD_FEATURES + ["tx_id", "user_id", "created_at", "is_fraud",
                                 "fraud_kind"]].copy()
    fraud["label"] = fraud["is_fraud"].astype(np.int8)
    fraud.to_parquet(gold / "fraud_training.parquet", index=False)

    # ---- credit training table (user level, default classification)
    rng = np.random.default_rng(seed)
    ref_ts = int(tx["created_at"].max())
    cutoff = ref_ts - 30 * 86400
    recent = tx[tx["created_at"] >= cutoff]
    agg = recent.groupby("user_id").agg(
        tx_count_30d=("tx_id", "count"),
        topup_count_30d=("is_topup", "sum"),
        avg_topup_amount=("amount_naira", lambda s: s[recent.loc[s.index, "type"] == "topup"].mean() if (recent.loc[s.index, "type"] == "topup").any() else 0.0),
        toll_spend_30d=("amount_naira", lambda s: s[recent.loc[s.index, "type"] == "toll_charge"].sum()),
    )
    cb = tx[tx["type"] == "chargeback"].groupby("user_id")["tx_id"].count()
    bal = tx.sort_values("created_at").groupby("user_id").agg(
        avg_balance_proxy=("amount_z", "mean"),
        balance_volatility=("amount_z", "std"))
    cr = users[["user_id", "kyc_tier", "created_at", "is_fraudster"]].copy()
    cr = cr.merge(kyc[["user_id", "kyc_score"]], on="user_id", how="left")
    cr = cr.merge(agg, left_on="user_id", right_index=True, how="left")
    cr = cr.merge(bal, left_on="user_id", right_index=True, how="left")
    cr["has_chargeback"] = cr["user_id"].isin(cb.index).astype(np.int8)
    cr["account_age_days"] = ((ref_ts - cr["created_at"]) / 86400).clip(lower=1)
    for c in ("tx_count_30d", "topup_count_30d", "avg_topup_amount",
              "toll_spend_30d", "avg_balance_proxy"):
        cr[c] = cr[c].fillna(0.0)
    cr["balance_volatility"] = cr["balance_volatility"].fillna(0.0)
    # scorecard-style monotone transforms
    cr["avg_topup_amount_log"] = np.log1p(cr["avg_topup_amount"])
    cr["toll_spend_30d_log"] = np.log1p(cr["toll_spend_30d"])
    cr["avg_balance_proxy_log"] = np.log1p(cr["avg_balance_proxy"].clip(lower=0))
    # default label: fraudsters default; thin-files w/ chargeback default; plus noise
    p_default = (0.04
                 + 0.70 * cr["is_fraudster"].astype(float)
                 + 0.45 * cr["has_chargeback"]
                 + 0.12 * (cr["kyc_tier"] == 1).astype(float)
                 + 0.10 * (cr["kyc_score"] < 40).astype(float)
                 - 0.05 * np.log1p(cr["tx_count_30d"])
                 - 0.05 * (cr["account_age_days"] > 180).astype(float))
    p_default = p_default.clip(0.01, 0.95)
    cr["label"] = (rng.random(len(cr)) < p_default).astype(np.int8)
    cr[CREDIT_FEATURES + ["user_id", "label"]].to_parquet(
        gold / "credit_training.parquet", index=False)

    # ---- GNN tables
    # union with users table: zero-activity users must still have nodes
    dev_ids = pd.unique(pd.concat([tx["device_id"], users["device_id"]]))
    ip_ids = pd.unique(pd.concat([tx["ip"], users["ip"]]))
    dev_map = {d: i for i, d in enumerate(dev_ids)}
    ip_map = {d: i for i, d in enumerate(ip_ids)}
    n_user = len(users)
    n_dev, n_ip = len(dev_ids), len(ip_ids)
    # node feature vector: [is_user,is_dev,is_ip, tier/3, log1p(degree)/5, age_norm]
    deg_u = tx.groupby("user_id")["tx_id"].count().reindex(users["user_id"]).fillna(0)
    ux = np.stack([
        np.ones(n_user), np.zeros(n_user), np.zeros(n_user),
        users["kyc_tier"].to_numpy() / 3.0,
        np.log1p(deg_u.to_numpy()) / 5.0,
        np.clip((ref_ts - users["created_at"].to_numpy()) / 86400 / 365, 0, 2) / 2,
    ], axis=1).astype(np.float32)
    dx = np.stack([
        np.zeros(n_dev), np.ones(n_dev), np.zeros(n_dev),
        np.zeros(n_dev),
        np.log1p(pd.Series(dev_map.keys()).map(
            users.groupby("device_id")["user_id"].count()).fillna(1).to_numpy()) / 3.0,
        np.zeros(n_dev),
    ], axis=1).astype(np.float32)
    ix = np.stack([
        np.zeros(n_ip), np.zeros(n_ip), np.ones(n_ip),
        np.zeros(n_ip),
        np.log1p(pd.Series(ip_map.keys()).map(
            users.groupby("ip")["user_id"].count()).fillna(1).to_numpy()) / 3.0,
        np.zeros(n_ip),
    ], axis=1).astype(np.float32)
    node_x = np.vstack([ux, dx, ix])
    node_id = np.arange(len(node_x))
    node_kind = np.array(["user"] * n_user + ["device"] * n_dev + ["ip"] * n_ip)
    pd.DataFrame({"node_id": node_id, "kind": node_kind}).to_parquet(
        gold / "gnn_nodes.parquet", index=False)
    np.save(gold / "gnn_x.npy", node_x)

    u_idx = users.sort_values("user_id")["user_id"].to_numpy().astype(np.int64) - 1
    dev_node = users["device_id"].map(dev_map).to_numpy().astype(np.int64) + n_user
    ip_node = users["ip"].map(ip_map).to_numpy().astype(np.int64) + n_user + n_dev
    e_src = [u_idx, u_idx]
    e_dst = [dev_node, ip_node]
    xfer = edges[edges["etype"] == "transfer"]
    if len(xfer):
        xs = xfer["src"].astype(np.int64).to_numpy() - 1
        xd = xfer["dst"].astype(np.int64).to_numpy() - 1
        e_src.append(xs); e_dst.append(xd)
    src = np.concatenate(e_src); dst = np.concatenate(e_dst)
    # undirected
    edge_src = np.concatenate([src, dst])
    edge_dst = np.concatenate([dst, src])
    pd.DataFrame({"src": edge_src, "dst": edge_dst}).to_parquet(
        gold / "gnn_edges.parquet", index=False)

    labels = np.full(len(node_x), -1, dtype=np.int64)
    labels[:n_user] = users.sort_values("user_id")["is_fraudster"].astype(np.int64)
    pd.DataFrame({"node_id": node_id, "label": labels}).to_parquet(
        gold / "gnn_labels.parquet", index=False)

    print(f"[gold] fraud={len(fraud)} credit={len(cr)} "
          f"gnn_nodes={len(node_x)} gnn_edges={len(edge_src)} "
          f"in {time.time()-t0:.1f}s")
    return {"fraud": fraud, "credit": cr, "node_x": node_x,
            "edge_src": edge_src, "edge_dst": edge_dst, "labels": labels,
            "n_user": n_user}


if __name__ == "__main__":
    f = build_silver()
    build_gold(frames={**f, "edges": pd.read_parquet(LAKE / "bronze" / "edges.parquet")})
