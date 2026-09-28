"""Realistic synthetic Nigerian KYC + wallet/payments data generator.

Generates the "production" dataset for the NigeriaPass toll PWA ML stack:

  bronze/  raw entities: users, kyc_applications, wallet_transactions, devices, edges
  silver/  cleaned + typed + enriched rows (per-tx velocity / sharing features)
  gold/    model-ready training tables (fraud tx table, credit user table, GNN graph)

Documented distributions (see docs/ML.md):
  - 36 states + FCT with approximate population-proportional weights
  - +234 MSISDNs (070x/080x/081x/090x/091x prefixes)
  - 11-digit NINs, Nigerian plate formats (ABC-123DE / ABC-123DEF etc.)
  - Top-up amounts: lognormal, median ~= NGN 2,500 (heavy right tail)
  - Toll charges: lognormal, median ~= NGN 350
  - Time-of-day: mixture peaked 07-09h and 17-20h WAT, low at night
  - ~2% injected fraud: mule rings, velocity attacks, SIM-swap drains,
    agent-applicant collusion clusters, chargeback fraud, synthetic identities

Deterministic for a fixed --seed.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
LAKE = ROOT / "lakehouse"

# ---------------------------------------------------------------- reference data
STATES = [  # (state, approx population weight, plate prefix letters)
    ("Lagos", 15.0, "LAG"), ("Kano", 9.5, "KAN"), ("Kaduna", 6.0, "KAD"),
    ("Rivers", 5.5, "RIV"), ("Oyo", 5.5, "OYO"), ("Katsina", 5.0, "KTS"),
    ("Borno", 4.5, "BRN"), ("Bauchi", 4.5, "BAU"), ("Anambra", 4.2, "ANB"),
    ("Jigawa", 4.0, "JIG"), ("Benue", 4.0, "BEN"), ("Niger", 3.8, "NGR"),
    ("Imo", 3.8, "IMO"), ("Sokoto", 3.6, "SOK"), ("Ogun", 3.6, "OGN"),
    ("Delta", 3.5, "DEL"), ("Plateau", 3.4, "PLT"), ("Edo", 3.4, "EDO"),
    ("Enugu", 3.3, "ENU"), ("FCT", 3.2, "FCT"), ("Akwa Ibom", 3.2, "AKW"),
    ("Osun", 3.0, "OSN"), ("Ondo", 3.0, "OND"), ("Adamawa", 2.8, "ADA"),
    ("Kwara", 2.6, "KWA"), ("Kebbi", 2.5, "KEB"), ("Zamfara", 2.5, "ZAM"),
    ("Abia", 2.4, "ABI"), ("Cross River", 2.4, "CRV"), ("Gombe", 2.3, "GOM"),
    ("Yobe", 2.2, "YOB"), ("Kogi", 2.2, "KOG"), ("Taraba", 2.1, "TAR"),
    ("Ebonyi", 2.0, "EBY"), ("Ekiti", 1.9, "EKT"), ("Nasarawa", 1.9, "NAS"),
    ("Bayelsa", 1.4, "BAY"),
]
STATE_NAMES = [s[0] for s in STATES]
STATE_W = np.array([s[1] for s in STATES], dtype=float)
STATE_W /= STATE_W.sum()

FIRST_NAMES = [
    "Chinedu", "Adebayo", "Ngozi", "Ibrahim", "Aisha", "Olufemi", "Chiamaka",
    "Musa", "Funke", "Emeka", "Blessing", "Tunde", "Fatima", "Obinna", "Yusuf",
    "Adaeze", "Segun", "Halima", "Kelechi", "Yetunde", "Uche", "Zainab",
    "Oluwaseun", "Nnamdi", "Amara", "Gbenga", "Hadiza", "Ifeanyi", "Toyin",
    "Abdullahi", "Chidinma", "Rotimi", "Nkechi", "Suleiman", "Omotola",
    "Chukwuma", "Bolanle", "Danjuma", "Ebere", "Kayode", "Maryam", "Osahon",
    "Titilayo", "Usman", "Adaugo", "Femi", "Bilkisu", "Ikechukwu", "Damilola",
]
LAST_NAMES = [
    "Okafor", "Adeyemi", "Abubakar", "Eze", "Olawale", "Nwosu", "Bello",
    "Adeleke", "Okonkwo", "Mohammed", "Ogunleye", "Chukwu", "Aliyu", "Bakare",
    "Obi", "Sule", "Adebayo", "Umeh", "Garba", "Falana", "Nwachukwu",
    "Ogundele", "Musa", "Adeola", "Ikenna", "Oyekan", "Danladi", "Osei",
    "Adewale", "Onyema", "Badmus", "Yakubu", "Ajayi", "Igwe", "Olanrewaju",
    "Shehu", "Anyanwu", "Fashola", "Udoka", "Lawal", "Okoro", "Ogunbiyi",
    "Nze", "Aminu", "Balogun", "Ezeani", "Oladipo", "Isa", "Maduka",
]
PHONE_PREFIXES = ["0701", "0703", "0704", "0705", "0706", "0802", "0803",
                  "0805", "0806", "0807", "0808", "0809", "0810", "0811",
                  "0812", "0813", "0814", "0815", "0816", "0817", "0818",
                  "0901", "0902", "0903", "0904", "0905", "0906", "0907",
                  "0912", "0913", "0915", "0916"]
LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"

TIER_PROBS = [0.55, 0.30, 0.15]  # tier 1 (basic), 2 (verified), 3 (full)


def _phones(rng, n):
    pref = rng.choice(PHONE_PREFIXES, n)
    rest = rng.integers(0, 10_000_000, n)
    return np.array([f"+234{p[1:]}{r:07d}" for p, r in zip(pref, rest)])


def _nins(rng, n):
    """11-digit NINs (cannot start with 0)."""
    return [str(x) for x in rng.integers(10**10, 10**11 - 1, n)]


def _plate(rng):
    l = lambda k: "".join(rng.choice(list(LETTERS), k))
    return f"{l(3)}-{rng.integers(100, 999)}{l(2)}"


def generate(n_users: int = 50_000, n_tx: int = 500_000, seed: int = 42,
             out_dir: Path | None = None, fraud_rate: float = 0.02) -> dict:
    t0 = time.time()
    rng = np.random.default_rng(seed)
    out = out_dir or LAKE
    bronze, silver, gold = (out / x for x in ("bronze", "silver", "gold"))
    for d in (bronze, silver, gold):
        d.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------ users
    uid = np.arange(1, n_users + 1)
    first = rng.choice(FIRST_NAMES, n_users)
    last = rng.choice(LAST_NAMES, n_users)
    states = rng.choice(STATE_NAMES, n_users, p=STATE_W)
    tiers = rng.choice([1, 2, 3], n_users, p=TIER_PROBS)
    base_ts = 1_700_000_000  # ~Nov 2023
    horizon = 360 * 86400
    created = base_ts + rng.integers(0, horizon - 30 * 86400, n_users)
    devices = np.array([f"dev-{rng.integers(10**9, 10**10):x}" for _ in range(n_users)])
    # shared IP subnets (CGNAT realism): ~8k distinct /24s
    ips = np.array(["197.210.%d.%d" % (rng.integers(0, 256), rng.integers(1, 255))
                    for _ in range(n_users)])
    nins = _nins(rng, n_users)
    phones = _phones(rng, n_users)
    is_driver = rng.random(n_users) < 0.6
    plates = np.where(is_driver, [_plate(rng) for _ in range(n_users)], "")

    users = pd.DataFrame({
        "user_id": uid, "name": first + " " + last, "phone": phones,
        "state": states, "nin": nins, "plate": plates,
        "kyc_tier": tiers, "created_at": created,
        "device_id": devices, "ip": ips,
    })

    # ------------------------------------------------------------ fraud injection
    n_fraud_users = int(n_users * fraud_rate)
    fraud_users = np.zeros(n_users, dtype=bool)

    # 1) mule rings: clusters sharing one device + one IP
    n_rings = max(10, n_fraud_users // 5 // 4)
    ring_members = []
    ring_id_of = {}
    for r in range(n_rings):
        size = rng.integers(3, 8)
        members = rng.choice(n_users, size, replace=False)
        fraud_users[members] = True
        ring_dev = f"dev-ring-{r:04d}"
        ring_ip = f"102.89.{r % 250}.{rng.integers(1, 255)}"
        users.loc[users.index[members], "device_id"] = ring_dev
        users.loc[users.index[members], "ip"] = ring_ip
        ring_members.append(members)
        for m in members:
            ring_id_of[int(m)] = r

    # 2) velocity attackers (lone wolves): rapid bursts
    n_vel = n_fraud_users // 4
    vel_users = rng.choice(np.setdiff1d(np.arange(n_users),
                                        np.concatenate(ring_members)),
                           min(n_vel, 2000), replace=False)
    fraud_users[vel_users] = True

    # 3) SIM-swap: device change then drain
    n_sim = n_fraud_users // 5
    sim_users = rng.choice(np.setdiff1d(np.arange(n_users), np.where(fraud_users)[0]),
                           min(n_sim, 1500), replace=False)
    fraud_users[sim_users] = True

    # 4) agent-applicant collusion clusters (for GNN labels): many fresh
    #    applicants share one "agent" device/IP and rubber-stamp each other
    n_coll_clusters = 12
    coll_members = []
    for c in range(n_coll_clusters):
        size = rng.integers(6, 15)
        pool = np.setdiff1d(np.arange(n_users), np.where(fraud_users)[0])
        members = rng.choice(pool, min(size, len(pool)), replace=False)
        fraud_users[members] = True
        users.loc[users.index[members], "device_id"] = f"dev-agent-{c:03d}"
        users.loc[users.index[members], "ip"] = f"41.58.{c}.{rng.integers(1, 255)}"
        coll_members.append(members)

    # 5) synthetic identities: near-duplicate NIN/phone, fresh accounts
    n_synid = n_fraud_users // 4
    pool = np.setdiff1d(np.arange(n_users), np.where(fraud_users)[0])
    synid_users = rng.choice(pool, min(n_synid, len(pool)), replace=False)
    fraud_users[synid_users] = True
    donors = rng.choice(n_users, len(synid_users))
    dup_nins = users["nin"].to_numpy()[donors]
    dup_phones = users["phone"].to_numpy()[donors]
    for i, u in enumerate(synid_users):  # one-digit mutation
        nin = list(dup_nins[i]); nin[rng.integers(0, 11)] = str(rng.integers(0, 10))
        users.iat[u, users.columns.get_loc("nin")] = "".join(nin)
        users.iat[u, users.columns.get_loc("phone")] = dup_phones[i][:-2] + f"{rng.integers(0,100):02d}"

    users["is_fraudster"] = fraud_users
    print(f"[gen] users={n_users} fraud_users={fraud_users.sum()} ({fraud_users.mean():.2%})")

    # ------------------------------------------------------------ devices table
    dev_grp = users.groupby("device_id").agg(
        n_users=("user_id", "count"), first_seen=("created_at", "min")).reset_index()
    dev_grp["is_ring_device"] = dev_grp["device_id"].str.contains("ring|agent")

    # ------------------------------------------------------------ transactions
    # assign tx counts: heavy-tailed activity (many idle users)
    act = rng.gamma(shape=1.2, scale=1.0, size=n_users)
    act = act / act.sum()
    tx_user = rng.choice(n_users, n_tx, p=act)
    tx_user.sort()
    tx_user = np.ascontiguousarray(tx_user)

    # timestamps within user's account lifetime
    u_created = users["created_at"].to_numpy()
    span = (base_ts + horizon) - u_created[tx_user] - 86400
    tx_ts = u_created[tx_user] + (rng.random(n_tx) * np.maximum(span, 3600)).astype(np.int64)

    # time-of-day shaping: shift a fraction of timestamps into commute peaks
    frac_peak = 0.45
    peak_mask = rng.random(n_tx) < frac_peak
    day0 = (tx_ts // 86400) * 86400
    peak_hour = np.where(rng.random(n_tx) < 0.5,
                         rng.integers(7, 10, n_tx), rng.integers(17, 21, n_tx))
    tx_ts = np.where(peak_mask, day0 + peak_hour * 3600 + rng.integers(0, 3600, n_tx), tx_ts)

    tx_type = rng.choice(["topup", "toll_charge", "transfer", "refund", "chargeback"],
                         n_tx, p=[0.30, 0.52, 0.14, 0.03, 0.01])
    topup_amt = np.exp(rng.normal(math.log(2500), 1.05, n_tx))  # median N2,500
    toll_amt = np.exp(rng.normal(math.log(350), 0.55, n_tx))     # median N350
    xfer_amt = np.exp(rng.normal(math.log(4000), 1.0, n_tx))
    amount = np.where(tx_type == "topup", topup_amt,
             np.where(tx_type == "toll_charge", toll_amt, xfer_amt))
    amount = np.clip(np.round(amount / 5) * 5, 50, 5_000_000)  # N5 rounding

    refs = np.where(tx_type == "topup",
                    ["NP-TOPUP-%d-%d" % (u, t) for u, t in zip(uid[tx_user], tx_ts)],
                    np.where(tx_type == "transfer",
                             ["NP-P2P-%d-%d" % (u, t) for u, t in zip(uid[tx_user], tx_ts)], ""))

    tx = pd.DataFrame({
        "tx_id": np.arange(1, n_tx + 1),
        "user_id": uid[tx_user],
        "wallet_id": uid[tx_user],
        "type": tx_type,
        "amount_naira": amount.astype(np.float64),
        "external_ref": refs,
        "created_at": tx_ts,
        "device_id": users["device_id"].to_numpy()[tx_user],
        "ip": users["ip"].to_numpy()[tx_user],
        "is_fraud": False,
    })

    # --- fraud transactions -------------------------------------------------
    fu_idx = np.where(fraud_users)[0]
    # a) mule rings: circular transfers + cash-out topups between ring members
    ring_tx_rows = []
    for members in ring_members:
        if len(members) < 2:
            continue
        m_uid = uid[members]
        n_rt = len(members) * rng.integers(4, 10)
        src_pos = rng.integers(0, len(members), n_rt)
        dst_pos = (src_pos + rng.integers(1, len(members), n_rt)) % len(members)
        src_m, dst_m = members[src_pos], members[dst_pos]
        tts = u_created[src_m] + rng.integers(86400, 90 * 86400, n_rt)
        amts = np.exp(rng.normal(math.log(15000), 0.6, n_rt)).round(-1)
        ring_tx_rows.append(pd.DataFrame({
            "user_id": m_uid[src_pos], "type": "transfer", "amount_naira": amts,
            "created_at": tts, "device_id": users["device_id"].to_numpy()[src_m],
            "ip": users["ip"].to_numpy()[src_m],
            "counterparty": m_uid[dst_pos], "is_fraud": True,
            "fraud_kind": "mule_ring",
        }))
    # b) velocity attacks: 8-20 tx within an hour
    vel_rows = []
    for v in vel_users[:1500]:
        burst = rng.integers(8, 20)
        t0v = u_created[v] + rng.integers(86400, 120 * 86400)
        tts = t0v + rng.integers(0, 3600, burst)
        amts = np.exp(rng.normal(math.log(8000), 0.5, burst)).round(-1)
        vel_rows.append(pd.DataFrame({
            "user_id": uid[v], "type": rng.choice(["topup", "transfer"], burst),
            "amount_naira": amts, "created_at": tts,
            "device_id": users.at[v, "device_id"], "ip": users.at[v, "ip"],
            "counterparty": 0, "is_fraud": True, "fraud_kind": "velocity",
        }))
    # c) SIM-swap: new device, then 1-3 big drains at odd hours
    sim_rows = []
    for s in sim_users[:1200]:
        t0s = u_created[s] + rng.integers(30 * 86400, 200 * 86400)
        n_drain = rng.integers(1, 4)
        tts = t0s + rng.integers(600, 7200, n_drain)
        night = ((tts // 3600) % 24)
        amts = np.exp(rng.normal(math.log(45000), 0.5, n_drain)).round(-1)
        sim_rows.append(pd.DataFrame({
            "user_id": uid[s], "type": "transfer", "amount_naira": amts,
            "created_at": tts, "device_id": f"dev-swap-{s:06d}",
            "ip": f"105.112.{rng.integers(0,256)}.{rng.integers(1,255)}",
            "counterparty": 0, "is_fraud": True, "fraud_kind": "sim_swap",
        }))
    # d) chargeback fraud: topup then chargeback reversal
    cb_pool = rng.choice(fu_idx, min(800, len(fu_idx)), replace=False)
    cb_rows = []
    for c in cb_pool:
        t0c = u_created[c] + rng.integers(7 * 86400, 150 * 86400)
        amt = float(np.exp(rng.normal(math.log(20000), 0.7)))
        cb_rows.append(pd.DataFrame({
            "user_id": uid[c], "type": ["topup", "chargeback"],
            "amount_naira": [round(amt, -1), round(amt, -1)],
            "created_at": [t0c, t0c + rng.integers(86400 * 3, 86400 * 20)],
            "device_id": users.at[c, "device_id"], "ip": users.at[c, "ip"],
            "counterparty": 0, "is_fraud": [True, True], "fraud_kind": "chargeback",
        }))

    fraud_tx = pd.concat(ring_tx_rows + vel_rows + sim_rows + cb_rows,
                         ignore_index=True)
    fraud_tx["tx_id"] = np.arange(n_tx + 1, n_tx + 1 + len(fraud_tx))
    fraud_tx["wallet_id"] = fraud_tx["user_id"]
    fraud_tx["external_ref"] = ["NP-FRAUD-%d-%d" % (u, t)
                                for u, t in zip(fraud_tx["user_id"], fraud_tx["created_at"])]
    tx_all = pd.concat([tx.assign(counterparty=0, fraud_kind=""), fraud_tx],
                       ignore_index=True)
    print(f"[gen] txs={len(tx_all)} fraud_txs={fraud_tx['is_fraud'].sum()} "
          f"({fraud_tx['is_fraud'].sum()/len(tx_all):.2%} of all)")

    # ------------------------------------------------------------ KYC applications
    kyc_status = rng.choice(["approved", "pending", "rejected", "in_review"],
                            n_users, p=[0.72, 0.14, 0.08, 0.06])
    kyc_type = np.where(is_driver, "driver",
                np.where(rng.random(n_users) < 0.7, "vehicle", "fleet"))
    kyc_score = np.clip((tiers * 22 + rng.normal(20, 12, n_users)).round(), 0, 100)
    kyc = pd.DataFrame({
        "application_id": np.arange(1, n_users + 1),
        "reference_id": ["DRV-%05X" % i for i in uid],
        "user_id": uid, "type": kyc_type, "status": kyc_status,
        "kyc_score": kyc_score.astype(int),
        "created_at": created + rng.integers(0, 86400 * 3, n_users),
        "reviewed_at": created + rng.integers(86400, 86400 * 14, n_users),
        "reviewer_decision": np.where(kyc_status == "approved", "approve",
                             np.where(kyc_status == "rejected", "reject", "")),
    })
    # collusion clusters: fast approvals, suspiciously high scores
    for members in coll_members:
        m_uid = uid[members]
        kyc.loc[kyc["user_id"].isin(m_uid), ["status", "reviewer_decision"]] = \
            ["approved", "approve"]
        kyc.loc[kyc["user_id"].isin(m_uid), "kyc_score"] = rng.integers(85, 100, len(m_uid))

    # ------------------------------------------------------------ write bronze
    users.to_parquet(bronze / "users.parquet", index=False)
    kyc.to_parquet(bronze / "kyc_applications.parquet", index=False)
    tx_all.to_parquet(bronze / "wallet_transactions.parquet", index=False)
    dev_grp.to_parquet(bronze / "devices.parquet", index=False)

    # edges: user-device, user-ip, user-user transfers
    e1 = pd.DataFrame({"src": uid, "dst": users["device_id"], "etype": "uses_device"})
    e2 = pd.DataFrame({"src": uid, "dst": users["ip"], "etype": "uses_ip"})
    xfer = tx_all[tx_all["counterparty"] > 0]
    e3 = pd.DataFrame({"src": xfer["user_id"].astype(str).to_numpy(),
                       "dst": xfer["counterparty"].astype(str).to_numpy(),
                       "etype": "transfer"})
    edges = pd.concat([e1, e2, e3], ignore_index=True)
    edges["src"] = edges["src"].astype(str)
    edges["dst"] = edges["dst"].astype(str)
    edges.to_parquet(bronze / "edges.parquet", index=False)

    meta = {"seed": seed, "n_users": n_users, "n_tx": int(len(tx_all)),
            "fraud_tx": int(tx_all["is_fraud"].sum()),
            "fraud_users": int(fraud_users.sum()),
            "generated_in_s": round(time.time() - t0, 1)}
    (bronze / "_meta.json").write_text(json.dumps(meta, indent=2))
    print(f"[gen] bronze written in {meta['generated_in_s']}s -> {bronze}")
    return {"users": users, "kyc": kyc, "tx": tx_all, "devices": dev_grp,
            "edges": edges, "meta": meta}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", type=int, default=50_000)
    ap.add_argument("--tx", type=int, default=500_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", type=str, default=str(LAKE))
    args = ap.parse_args()
    generate(args.users, args.tx, args.seed, Path(args.out))
