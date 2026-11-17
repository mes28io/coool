"""Offline per-step eval: replay recorded screens (oracle-labelled) through a scorer.

python offline_eval.py <dataset.jsonl> <spec> <out.jsonl>    spec: mlx:<dir> | mlxid:<dir> | haiku
Writes one row per state: gold, pred, p, ms, K, (tokens/$ for haiku).
"""
import json
import sys
import time

from pilots import build_pilot


def main():
    ds, spec, out = sys.argv[1], sys.argv[2], sys.argv[3]
    rows = [json.loads(l) for l in open(ds)]
    pilot = build_pilot(spec)
    if hasattr(pilot, "score"):  # warm-up compile
        pilot.decide_raw(rows[0]["goal"], rows[0]["inputs"], rows[0]["history"], rows[0]["screen"], rows[0]["actions"])
    with open(out, "w") as f:
        for r in rows:
            try:
                d = pilot.decide_raw(r["goal"], r["inputs"], r["history"], r["screen"], r["actions"])
            except RuntimeError as e:
                print("stop:", e)
                break
            probs = d.pop("probs", None)
            rec = {"task": r["task"], "run": r["run"], "step": r["step"], "K": len(r["actions"]),
                   "gold": r["gold"], "pred": d["id"], "ok": d["id"] == r["gold"], **d}
            if probs:
                rec["p_gold"] = probs[r["gold"]]
            f.write(json.dumps(rec) + "\n")
            f.flush()
    rs = [json.loads(l) for l in open(out)]
    acc = sum(r["ok"] for r in rs) / len(rs)
    ms = sorted(r["ms"] for r in rs)
    print(f"{spec}: n={len(rs)} acc={acc:.3f} p50={ms[len(ms)//2]:.0f}ms p95={ms[int(len(ms)*.95)]:.0f}ms")


if __name__ == "__main__":
    main()
