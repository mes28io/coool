"""Closed-loop runner: perceive -> decide -> act on the simulator, logging per-step timings.

python run.py <udid-file> <pilot> <runs> [task,task] [--out file.jsonl]
pilots: oracle | mlx:<model-dir> | haiku | hybrid:<model-dir>:<tau> | memory:<inner-spec>
"""
from __future__ import annotations

import argparse
import json
import re
import time

from device import Device
from tasks import make_tasks, oracle


def history_lines(hist):
    return [f"{i+1}. {h}" for i, h in enumerate(hist)]


class OraclePilot:
    name = "oracle"

    def begin(self, task):
        self.ptr = 0
        self.task = task

    def decide(self, task, screen, hist):
        a, self.ptr = oracle(task, screen, self.ptr)
        return {"id": a.id, "p": 1.0, "ms": 0.0, "src": "oracle"}

    def end(self, ok):
        pass


def make_pilot(spec: str):
    if spec == "oracle":
        return OraclePilot()
    from pilots import build_pilot
    return build_pilot(spec)


def run_episode(dev: Device, task, pilot, run: int, out, dataset=None, settle=0.45):
    task.reset(dev)
    t0 = time.perf_counter()
    dev.start(task.bundle)
    time.sleep(1.2)
    # apps restore their last screen on relaunch: back out to the app's root before the pilot starts
    for _ in range(3):
        scr = dev.perceive(task.inputs)
        if any(re.search(task.plan[0], a.describe()) for a in scr.actions):
            break
        hit =next((a for r in task.recover for a in scr.actions if re.search(r, a.describe())), None)
        if hit is None:
            break
        dev.act(hit, task.inputs)
        time.sleep(0.8)
    pilot.begin(task)
    hist, steps, ok, end = [], [], False, "max_steps"
    oracle_ptr = 0
    screen = None
    for step in range(task.max_steps):
        tp = time.perf_counter()
        screen = dev.perceive(task.inputs)
        perceive_ms = (time.perf_counter() - tp) * 1000
        gold, oracle_ptr2 = oracle(task, screen, oracle_ptr)
        dec = pilot.decide(task, screen, hist)
        a = screen.actions[dec["id"]]
        if dataset is not None:
            dataset.write(json.dumps({
                "task": task.name, "run": run, "step": step, "goal": task.goal, "inputs": task.inputs,
                "history": list(hist), "screen": screen.render(), "app": screen.app,
                "actions": [x.describe() for x in screen.actions], "keys": [x.key() for x in screen.actions],
                "signature": screen.signature(), "gold": gold.id}) + "\n")
        if a.id == gold.id:
            oracle_ptr = oracle_ptr2
        rec = {"step": step, "perceive_ms": perceive_ms, "K": len(screen.actions), "action": a.describe(),
               "gold": gold.describe(), "match": a.id == gold.id, **{k: v for k, v in dec.items() if k != "id"}}
        if a.verb in ("done", "stuck"):
            end = a.verb
            rec["act_ms"] = 0.0
            steps.append(rec)
            break
        ta = time.perf_counter()
        dev.act(a, task.inputs)
        time.sleep(settle)
        rec["act_ms"] = (time.perf_counter() - ta) * 1000
        steps.append(rec)
        hist.append(a.describe() if a.verb != "type" else f"typed {task.inputs[a.text_key]!r} into {a.target.describe()}")
    final = dev.perceive(task.inputs)
    ok = bool(task.verify(dev, final))
    pilot.end(ok)
    wall = (time.perf_counter() - t0) * 1000
    ep = {"pilot": pilot.name, "task": task.name, "run": run, "ok": ok, "end": end, "n_steps": len(steps),
          "wall_ms": wall, "steps": steps}
    out.write(json.dumps(ep) + "\n")
    out.flush()
    print(f"[{pilot.name}] {task.name} run{run}: ok={ok} end={end} steps={len(steps)} wall={wall/1000:.1f}s "
          f"dec_ms={[round(s.get('ms', 0)) for s in steps]} match={sum(s['match'] for s in steps)}/{len(steps)}",
          flush=True)
    return ep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("udid_file")
    ap.add_argument("pilot")
    ap.add_argument("runs", type=int)
    ap.add_argument("--tasks", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dataset", default="")
    ap.add_argument("--run-offset", type=int, default=0)
    args = ap.parse_args()
    udid = open(args.udid_file).read().strip()
    dev = Device(udid)
    pilot = make_pilot(args.pilot)
    ds = open(args.dataset, "a") if args.dataset else None
    with open(args.out, "a") as out:
        for r in range(args.run_offset, args.run_offset + args.runs):
            for task in make_tasks(udid, r):
                if args.tasks and task.name not in args.tasks.split(","):
                    continue
                try:
                    run_episode(dev, task, pilot, r, out, ds)
                except Exception as e:  # keep going; log the failure
                    print(f"[{pilot.name}] {task.name} run{r}: ERROR {e!r}", flush=True)
                    out.write(json.dumps({"pilot": pilot.name, "task": task.name, "run": r, "ok": False,
                                          "end": "error", "error": repr(e), "steps": []}) + "\n")
                    if getattr(pilot, "budget_exceeded", False):
                        return
    if ds:
        ds.close()


if __name__ == "__main__":
    main()
