"""Confidence via permutation consistency: score the screen twice (original + shuffled candidate order);
agreement is the escalation signal (raw softmax p is ~1.0 even when wrong for off-the-shelf small LMs).

python consistency_eval.py <dataset.jsonl> <model-dir> <out.jsonl>
"""
import json
import random
import sys
import time

from pilots import MLXScorer


def permuted(screen, actions, perm):
    head = screen.split("\nActions:\n")[0]
    lines = [f"[{i}] {actions[j]}" for i, j in enumerate(perm)]
    return head + "\nActions:\n" + "\n".join(lines), [actions[j] for j in perm]


def main():
    ds, model, out = sys.argv[1:4]
    sc = MLXScorer(model, mode="id")
    rows = [json.loads(l) for l in open(ds)]
    rng = random.Random(0)
    with open(out, "w") as f:
        for r in rows:
            a = sc.decide_raw(r["goal"], r["inputs"], r["history"], r["screen"], r["actions"])
            K = len(r["actions"])
            # keep the fixed verbs (scroll/back/done/stuck) at the end, shuffle the on-screen elements
            n_fixed = sum(1 for x in r["actions"] if not x.startswith(("tap ", "type ", "press ")))
            perm = list(range(K - n_fixed))
            rng.shuffle(perm)
            perm += list(range(K - n_fixed, K))
            scr2, acts2 = permuted(r["screen"], r["actions"], perm)
            t = time.perf_counter()
            b = sc.decide_raw(r["goal"], r["inputs"], r["history"], scr2, acts2)
            b_id = perm[b["id"]]
            f.write(json.dumps({"task": r["task"], "run": r["run"], "step": r["step"], "gold": r["gold"],
                                "a": a["id"], "b": b_id, "pa": a["p"], "pb": b["p"],
                                "ms_a": a["ms"], "ms_b": b["ms"]}) + "\n")
    R = [json.loads(l) for l in open(out)]
    agree = [r for r in R if r["a"] == r["b"]]
    print(f"n={len(R)} acc_a={sum(r['a']==r['gold'] for r in R)/len(R):.3f} "
          f"agree={len(agree)/len(R):.2f} acc|agree={sum(r['a']==r['gold'] for r in agree)/max(1,len(agree)):.3f} "
          f"acc|disagree={sum(r['a']==r['gold'] for r in R if r['a']!=r['b'])/max(1,len(R)-len(agree)):.3f}")


if __name__ == "__main__":
    main()
