"""Summaries: offline per-step accuracy/latency/calibration, hybrid threshold curve, closed-loop episodes.

python analyze.py offline <A.jsonl> [<A2.jsonl> ...] --haiku <B.jsonl>
python analyze.py episodes <episodes.jsonl> [...]
"""
import json
import statistics
import sys


def load(p):
    return [json.loads(l) for l in open(p)]


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else float("nan")


def offline(paths, haiku):
    B = {(r["task"], r["run"], r["step"]): r for r in load(haiku)} if haiku else {}
    if B:
        bs = list(B.values())
        print(f"B haiku: n={len(bs)} acc={sum(r['ok'] for r in bs)/len(bs):.3f} p50={pct([r['ms'] for r in bs],.5):.0f} "
              f"p95={pct([r['ms'] for r in bs],.95):.0f} $/dec={statistics.mean(r['usd'] for r in bs):.6f} "
              f"in_tok={statistics.mean(r['in_tok'] for r in bs):.0f}")
    for p in paths:
        A = load(p)
        acc = sum(r["ok"] for r in A) / len(A)
        ece, bins = 0.0, []
        for lo in (0, .5, .7, .9, .97):
            hi = {0: .5, .5: .7, .7: .9, .9: .97, .97: 1.01}[lo]
            sel = [r for r in A if lo <= r["p"] < hi]
            if sel:
                c = statistics.mean(r["p"] for r in sel)
                a = sum(r["ok"] for r in sel) / len(sel)
                ece += len(sel) / len(A) * abs(c - a)
                bins.append(f"[{lo:.2f},{min(hi,1):.2f}) n={len(sel)} conf={c:.2f} acc={a:.2f}")
        print(f"\nA {p.split('/')[-1]}: n={len(A)} acc={acc:.3f} p50={pct([r['ms'] for r in A],.5):.0f}ms "
              f"p95={pct([r['ms'] for r in A],.95):.0f}ms K~{statistics.mean(r['K'] for r in A):.0f} "
              f"suffix_tok~{statistics.mean(r.get('prefix_tokens',0) for r in A):.0f} ECE={ece:.3f}")
        for b in bins:
            print("   ", b)
        if not B:
            continue
        print("    hybrid tau | acc | escalated | mean ms | p95 ms | $/1k decisions")
        for tau in (0, .5, .7, .8, .9, .95, .98, .99, 1.01):
            ok, ms, usd, esc = 0, [], 0.0, 0
            for r in A:
                b = B.get((r["task"], r["run"], r["step"]))
                if b is None:
                    continue
                if r["p"] >= tau:
                    ok += r["ok"]
                    ms.append(r["ms"])
                else:
                    esc += 1
                    ok += b["ok"]
                    ms.append(r["ms"] + b["ms"])
                    usd += b["usd"]
            n = len(ms)
            print(f"    {tau:>4} | {ok/n:.3f} | {esc/n:.2f} | {statistics.mean(ms):.0f} | {pct(ms,.95):.0f} | {usd/n*1000:.3f}")


def episodes(paths):
    print("pilot | task-success | mean steps | dec p50/p95 ms | perceive p50 ms | act p50 ms | wall p50 s | $ total | step-match")
    eps = [e for p in paths for e in load(p)]
    by = {}
    for e in eps:
        by.setdefault(e["pilot"], []).append(e)
    for pilot, es in by.items():
        steps = [s for e in es for s in e["steps"]]
        dec = [s.get("ms", 0) for s in steps]
        usd = sum(s.get("usd", 0) or 0 for s in steps)
        srcs = {}
        for s in steps:
            srcs[s.get("src")] = srcs.get(s.get("src"), 0) + 1
        print(f"{pilot} | {sum(e['ok'] for e in es)}/{len(es)} | {statistics.mean(e['n_steps'] for e in es if 'n_steps' in e):.1f} | "
              f"{pct(dec,.5):.0f}/{pct(dec,.95):.0f} | {pct([s['perceive_ms'] for s in steps],.5):.0f} | "
              f"{pct([s['act_ms'] for s in steps if s['act_ms']],.5):.0f} | "
              f"{pct([e['wall_ms'] for e in es if 'wall_ms' in e],.5)/1000:.1f} | {usd:.4f} | "
              f"{sum(s['match'] for s in steps)}/{len(steps)} | src={srcs}")
        per = {}
        for e in es:
            per.setdefault(e["task"], []).append(e["ok"])
        print("    " + "  ".join(f"{t}:{sum(v)}/{len(v)}" for t, v in per.items()))


if __name__ == "__main__":
    if sys.argv[1] == "offline":
        args = sys.argv[2:]
        h = None
        if "--haiku" in args:
            i = args.index("--haiku")
            h = args[i + 1]
            args = args[:i] + args[i + 2:]
        offline(args, h)
    else:
        episodes(sys.argv[2:])
