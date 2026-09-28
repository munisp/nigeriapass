"""Champion/challenger A/B router.

Deterministic hash-based assignment (stable per user+model): the same user
always lands on the same arm until the challenger percentage changes.
Assignments are logged to the lakehouse (gold/ab_assignments parquet) for
offline per-arm metric slicing.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pandas as pd

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from registry import registry  # noqa: E402
from synthetic.features import LAKE  # noqa: E402

ASSIGN_LOG = LAKE / "gold" / "ab_assignments"


def assign(model: str, user_id: int | str, challenger_pct: int = 10) -> dict:
    """Return {"arm": "champion"|"challenger", "version": ..., "model": ...}.

    Falls back to champion (or the only available version) when no challenger
    is registered.
    """
    champ = registry.get_champion(model)
    chal = registry.get_challenger(model)
    if champ is None and chal is None:
        raise RuntimeError(f"no registered versions for model '{model}'")
    bucket = int(hashlib.md5(f"{model}:{user_id}".encode()).hexdigest(), 16) % 100
    arm = "challenger" if (chal is not None and bucket < challenger_pct) else "champion"
    entry = chal if arm == "challenger" else champ
    if entry is None:  # e.g. only challenger exists
        arm, entry = ("challenger", chal) if chal else ("champion", champ)
    rec = {"ts": int(time.time()), "model": model, "user_id": str(user_id),
           "bucket": bucket, "arm": arm, "version": entry["version"],
           "challenger_pct": challenger_pct}
    _log_assignment(rec)
    return {"arm": arm, "version": entry["version"], "model": model,
            "artifact_dir": entry["artifact_dir"]}


def _log_assignment(rec: dict):
    ASSIGN_LOG.mkdir(parents=True, exist_ok=True)
    # one small parquet file per batch of assignments; compact offline
    day = time.strftime("%Y%m%d")
    f = ASSIGN_LOG / f"assignments-{day}.jsonl"
    with f.open("a") as fh:
        fh.write(json.dumps(rec) + "\n")


def compact_assignment_log() -> Path:
    """Roll jsonl assignment logs into parquet for the lakehouse."""
    ASSIGN_LOG.mkdir(parents=True, exist_ok=True)
    rows = []
    for f in sorted(ASSIGN_LOG.glob("assignments-*.jsonl")):
        rows += [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
    if not rows:
        return ASSIGN_LOG
    out = ASSIGN_LOG / "ab_assignments.parquet"
    pd.DataFrame(rows).to_parquet(out, index=False)
    return out


if __name__ == "__main__":
    print(assign("fraud", 12345))
