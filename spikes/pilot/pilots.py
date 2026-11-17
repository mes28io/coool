"""System-1 pilots: a typed decision over a known candidate set.

Every pilot implements decide(task, screen, history) -> {"id", "p", "ms", "src", ...}.

A  MLXScorer   local LM; scores all K candidate continuations in ONE batched forward pass over a
               shared (KV-cached) prefix, softmax over sequence log-likelihoods -> calibrated-ish p.
B  HaikuPilot  claude-haiku-5-5 with a forced tool call whose input is an enum of candidate ids.
C  Hybrid      A first; escalate to B when A's top p < tau.
M  Memory      muscle memory: (goal, screen signature) -> action key replay; falls through on miss.
"""
from __future__ import annotations

import json
import os
import time

SYSTEM = (
    "You are the fast pilot operating an iPhone app for a coding agent. Each turn you get the goal, the "
    "input values you may type, the steps already taken, and the current screen as a numbered list of "
    "possible actions. Pick the single best next action. Typing an input taps the field first. "
    "Pick 'done' only when the goal is visibly achieved on the current screen. Pick 'stuck' only if no "
    "listed action can make progress.")


def user_block(goal, inputs, history, screen_render):
    inp = ", ".join(f"<{k}> = {v!r}" for k, v in inputs.items()) or "(none)"
    hist = "\n".join(f"{i+1}. {h}" for i, h in enumerate(history)) or "(nothing yet)"
    return f"Goal: {goal}\nInputs: {inp}\nSteps so far:\n{hist}\n\nCurrent screen:\n{screen_render}"


# ---------------------------------------------------------------- A: local MLX scorer
class MLXScorer:
    def __init__(self, path: str, mode: str = "full"):
        import mlx.core as mx
        from mlx_lm import load
        self.mx = mx
        self.model, self.tok = load(path)
        self.name = ("mlxid:" if mode == "id" else "mlx:") + os.path.basename(path.rstrip("/"))
        self.mode = mode  # full: "{id}] {desc}" ; id: "{id}]"
        self.qwen3 = "qwen3" in path.lower()

    def prompt(self, goal, inputs, history, screen_render):
        msgs = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": user_block(goal, inputs, history, screen_render)}]
        kw = {"enable_thinking": False} if self.qwen3 else {}
        p = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, **kw)
        return p + "Next action: ["

    def _static(self):
        if getattr(self, "static_cache", None) is None:
            from mlx_lm.models.cache import make_prompt_cache
            marker = "\u0001USER\u0001"
            msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": marker}]
            kw = {"enable_thinking": False} if self.qwen3 else {}
            full = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, **kw)
            self.static_text = full[: full.index(marker)]
            self.static_ids = self.tok.encode(self.static_text, add_special_tokens=False)
            self.static_cache = make_prompt_cache(self.model)
            out = self.model(self.mx.array(self.static_ids)[None], cache=self.static_cache)
            self.mx.eval(out, *[c.keys for c in self.static_cache])
        return self.static_cache

    def score(self, prefix: str, conts: list[str]):
        """log p(cont | prefix) for every continuation, one batched pass over a shared KV cache."""
        mx = self.mx
        from mlx_lm.models.cache import make_prompt_cache
        from mlx_lm.models.cache import KVCache
        static = self._static()
        assert prefix.startswith(self.static_text)
        ids = self.static_ids + self.tok.encode(prefix[len(self.static_text):], add_special_tokens=False)
        cache = []
        for c in static:  # reuse the KV of the static system prefix (computed once)
            n = KVCache()
            n.keys, n.values, n.offset = c.keys[..., : c.offset, :], c.values[..., : c.offset, :], c.offset
            cache.append(n)
        logits = self.model(mx.array(ids[len(self.static_ids):])[None], cache=cache)
        last = logits[0, -1].astype(mx.float32)
        last_lp = last - mx.logsumexp(last)
        K = len(conts)
        # tokenize continuations in context: tokens(prefix+cont) minus tokens(prefix) (robust to merges at
        # the boundary only approximately; we end the prefix with '[' so ids start a fresh token).
        ct = [self.tok.encode(c, add_special_tokens=False) for c in conts]
        L = max(len(c) for c in ct)
        pad = self.tok.eos_token_id or 0
        toks = mx.array([c + [pad] * (L - len(c)) for c in ct])
        for c in cache:  # tile the prefix cache to batch K
            off = c.offset
            c.keys = mx.repeat(c.keys[..., :off, :], K, axis=0)
            c.values = mx.repeat(c.values[..., :off, :], K, axis=0)
        out = self.model(toks, cache=cache).astype(mx.float32)          # (K, L, V)
        lp = out - mx.logsumexp(out, axis=-1, keepdims=True)
        tgt = toks[:, 1:]
        tok_lp = mx.take_along_axis(lp[:, :-1, :], tgt[..., None], axis=-1)[..., 0]  # (K, L-1)
        first = last_lp[toks[:, 0]]
        lens = mx.array([len(c) for c in ct])
        mask = (mx.arange(L - 1)[None, :] < (lens[:, None] - 1)).astype(mx.float32)
        total = first + (tok_lp * mask).sum(axis=1)
        mx.eval(total)
        return total.tolist(), [len(c) for c in ct]

    def decide_raw(self, goal, inputs, history, screen_render, action_descs):
        import math
        t = time.perf_counter()
        prefix = self.prompt(goal, inputs, history, screen_render)
        if self.mode == "id":
            conts = [f"{i}]" for i in range(len(action_descs))]
        else:
            conts = [f"{i}] {d}" for i, d in enumerate(action_descs)]
        lps, _ = self.score(prefix, conts)
        m = max(lps)
        ps = [math.exp(x - m) for x in lps]
        z = sum(ps)
        ps = [x / z for x in ps]
        best = max(range(len(ps)), key=ps.__getitem__)
        return {"id": best, "p": ps[best], "ms": (time.perf_counter() - t) * 1000, "src": "A",
                "probs": ps, "prefix_tokens": len(self.tok.encode(prefix))}

    # pilot interface
    def begin(self, task):
        pass

    def decide(self, task, screen, hist):
        d = self.decide_raw(task.goal, task.inputs, hist, screen.render(), [a.describe() for a in screen.actions])
        d.pop("probs")
        return d

    def end(self, ok):
        pass


LABELS = [chr(c) for c in range(ord("A"), ord("Z") + 1)] + [chr(c) for c in range(ord("a"), ord("z") + 1)]

FEWSHOT = """Example 1
Screen:
App: Settings
Actions:
[A] tap Button "General"
[B] tap Button "Wi-Fi"
[C] tap Button "Bluetooth"
[D] scroll down
[E] done: the goal is achieved
[F] stuck: cannot make progress, ask for help
Steps so far: (nothing yet)
Goal: Turn Bluetooth off.
Answer: C

Example 2
Screen:
App: Settings
Actions:
[A] tap Button "Settings"
[B] tap Switch "Bluetooth" (off)
[C] tap Button "Devices"
[D] scroll down
[E] done: the goal is achieved
[F] stuck: cannot make progress, ask for help
Steps so far:
1. tap Button "Bluetooth"
2. tap Switch "Bluetooth" (on)
Goal: Turn Bluetooth off.
Answer: E

Example 3
Screen:
App: Messages  (keyboard is up)
Actions:
[A] tap Button "Back"
[B] type <body> into TextField "Message"
[C] tap TextField "Message"
[D] tap Button "Send"
[E] press the keyboard Return/Search/Go key
[F] done: the goal is achieved
[G] stuck: cannot make progress, ask for help
Inputs: <body> = 'hi'
Steps so far:
1. tap Button "New Message"
Goal: Send the message body to Sam.
Answer: B
"""

SYSTEM_L = (
    "You choose the next action for an assistant operating an iPhone. You see the current screen as a "
    "lettered list of possible actions, the steps already taken and the goal. Reply with the letter of "
    "the single best next action. Typing an input taps its field first. Choose 'done' only when the "
    "screen shows the goal is already achieved; never repeat a step that already succeeded.\n\n" + FEWSHOT)


class MLXLabelScorer:
    """Jev-like: every candidate is a single label token; ONE forward pass over the per-step suffix
    (the static system/few-shot prefix is KV-cached once) yields the distribution over all K labels."""

    def __init__(self, path: str, temp: float = 1.0):
        import mlx.core as mx
        from mlx_lm import load
        from mlx_lm.models.cache import make_prompt_cache
        self.mx = mx
        self.model, self.tok = load(path)
        self.name = "mlxL:" + os.path.basename(path.rstrip("/"))
        self.temp = temp
        self.qwen3 = "qwen3" in path.lower()
        base = self.tok.encode("Answer:", add_special_tokens=False)
        self.label_ids = []
        for L in LABELS:
            ids = self.tok.encode("Answer: " + L, add_special_tokens=False)
            assert ids[: len(base)] == base and len(ids) == len(base) + 1, (L, ids)
            self.label_ids.append(ids[-1])
        assert len(set(self.label_ids)) == len(LABELS)
        marker = "\u0001USER\u0001"
        full = self._chat(marker)
        self.static_text = full[: full.index(marker)]
        self.static_ids = self.tok.encode(self.static_text, add_special_tokens=False)
        self.static_cache = make_prompt_cache(self.model)
        out = self.model(mx.array(self.static_ids)[None], cache=self.static_cache)
        mx.eval(out, *[c.keys for c in self.static_cache])

    def _chat(self, user):
        msgs = [{"role": "system", "content": SYSTEM_L}, {"role": "user", "content": user}]
        kw = {"enable_thinking": False} if self.qwen3 else {}
        return self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, **kw) + "Answer:"

    @staticmethod
    def relabel(screen_render):
        out = []
        for line in screen_render.split("\n"):
            if line.startswith("[") and "] " in line:
                i, rest = line[1:].split("] ", 1)
                try:
                    line = f"[{LABELS[int(i)]}] {rest}"
                except ValueError:
                    pass
            out.append(line)
        return "\n".join(out)

    def user_text(self, goal, inputs, history, screen_render):
        inp = ", ".join(f"<{k}> = {v!r}" for k, v in inputs.items())
        hist = "\n".join(f"{i+1}. {h}" for i, h in enumerate(history)) or "(nothing yet)"
        u = "Screen:\n" + self.relabel(screen_render) + "\n"
        if inp:
            u += f"Inputs: {inp}\n"
        return u + f"Steps so far:\n{hist}\nGoal: {goal}"

    def decide_raw(self, goal, inputs, history, screen_render, action_descs):
        mx = self.mx
        from mlx_lm.models.cache import KVCache
        t = time.perf_counter()
        K = len(action_descs)
        assert K <= len(LABELS), K
        full = self._chat(self.user_text(goal, inputs, history, screen_render))
        assert full.startswith(self.static_text)
        suffix_ids = self.tok.encode(full[len(self.static_text):], add_special_tokens=False)
        cache = []
        for c in self.static_cache:  # cheap copy of the cached static prefix
            n = KVCache()
            n.keys, n.values, n.offset = c.keys[..., : c.offset, :], c.values[..., : c.offset, :], c.offset
            cache.append(n)
        logits = self.model(mx.array(suffix_ids)[None], cache=cache)[0, -1].astype(mx.float32)
        sel = logits[mx.array(self.label_ids[:K])] / self.temp
        ps = mx.softmax(sel).tolist()
        best = max(range(K), key=ps.__getitem__)
        return {"id": best, "p": ps[best], "ms": (time.perf_counter() - t) * 1000, "src": "A",
                "probs": ps, "prefix_tokens": len(suffix_ids)}

    def begin(self, task):
        pass

    def decide(self, task, screen, hist):
        d = self.decide_raw(task.goal, task.inputs, hist, screen.render(), [a.describe() for a in screen.actions])
        d.pop("probs")
        return d

    def end(self, ok):
        pass


# ---------------------------------------------------------------- B: Haiku 5.5
HAIKU_IN, HAIKU_OUT = 0.10 / 1e6, 0.50 / 1e6  # $/token (<=100K prompt)
BUDGET_USD = float(os.environ.get("PILOT_BUDGET_USD", "1.8"))
_SPEND_FILE = os.environ.get("PILOT_SPEND_FILE", "")


def _spent() -> float:
    try:
        return float(open(_SPEND_FILE).read())
    except Exception:
        return 0.0


def _add_spend(x):
    if _SPEND_FILE:
        v = _spent() + x
        open(_SPEND_FILE, "w").write(f"{v:.6f}")


class HaikuPilot:
    name = "haiku"

    def __init__(self, model="claude-haiku-5-5"):
        import anthropic
        self.client = anthropic.Anthropic(max_retries=2)
        self.model = model
        self.budget_exceeded = False

    def decide_raw(self, goal, inputs, history, screen_render, action_descs):
        if _spent() > BUDGET_USD:
            self.budget_exceeded = True
            raise RuntimeError("budget exceeded")
        tool = {
            "name": "act",
            "description": "Perform the chosen action on the device.",
            "input_schema": {"type": "object", "additionalProperties": False, "required": ["action_id"],
                             "properties": {"action_id": {"type": "integer",
                                                          "enum": list(range(len(action_descs)))}}},
            "strict": True,
        }
        t = time.perf_counter()
        r = self.client.messages.create(
            model=self.model, max_tokens=64, system=SYSTEM,
            thinking={"type": "disabled"}, output_config={"effort": "low"},
            tools=[tool], tool_choice={"type": "tool", "name": "act"},
            messages=[{"role": "user", "content": user_block(goal, inputs, history, screen_render)}])
        ms = (time.perf_counter() - t) * 1000
        tu = next(b for b in r.content if b.type == "tool_use")
        aid = int(tu.input["action_id"])
        cost = r.usage.input_tokens * HAIKU_IN + r.usage.output_tokens * HAIKU_OUT
        _add_spend(cost)
        return {"id": aid, "p": None, "ms": ms, "src": "B", "in_tok": r.usage.input_tokens,
                "out_tok": r.usage.output_tokens, "usd": cost}

    def begin(self, task):
        pass

    def decide(self, task, screen, hist):
        return self.decide_raw(task.goal, task.inputs, hist, screen.render(), [a.describe() for a in screen.actions])

    def end(self, ok):
        pass


# ---------------------------------------------------------------- C: hybrid
class Hybrid:
    """tau >= 0: escalate when A's top p < tau.  tau < 0: 'agree' gate - score a second, shuffled
    ordering of the on-screen candidates and escalate when the two argmaxes disagree."""

    def __init__(self, a: MLXScorer, b: HaikuPilot, tau: float):
        self.a, self.b, self.tau = a, b, tau
        self.name = f"hybrid({a.name},{'agree' if tau < 0 else 'tau=' + str(tau)})"
        import random
        self.rng = random.Random(0)

    def _agree(self, task, screen, hist, da):
        descs = [a.describe() for a in screen.actions]
        n_fixed = sum(1 for a in screen.actions if a.verb not in ("tap", "type", "submit"))
        perm = list(range(len(descs) - n_fixed))
        self.rng.shuffle(perm)
        perm += list(range(len(descs) - n_fixed, len(descs)))
        head = screen.render().split("\nActions:\n")[0]
        scr2 = head + "\nActions:\n" + "\n".join(f"[{i}] {descs[j]}" for i, j in enumerate(perm))
        db = self.a.decide_raw(task.goal, task.inputs, hist, scr2, [descs[j] for j in perm])
        return perm[db["id"]] == da["id"], db["ms"]

    @property
    def budget_exceeded(self):
        return self.b.budget_exceeded

    def begin(self, task):
        pass

    def decide(self, task, screen, hist):
        da = self.a.decide(task, screen, hist)
        if self.tau < 0:
            ok, ms2 = self._agree(task, screen, hist, da)
            da["ms"] += ms2
            if ok:
                return da
        elif da["p"] >= self.tau:
            return da
        db = self.b.decide(task, screen, hist)
        db["ms"] += da["ms"]
        db["a_ms"] = da["ms"]
        db["a_p"] = da["p"]
        db["src"] = "A->B"
        return db

    def end(self, ok):
        pass


# ---------------------------------------------------------------- M: muscle memory
class Memory:
    """Replays (goal, screen signature) -> action key from previously SUCCESSFUL episodes."""

    def __init__(self, inner, path: str):
        self.inner, self.path = inner, path
        self.name = f"memory({inner.name})"
        try:
            self.store = json.load(open(path))
        except Exception:
            self.store = {}
        self.pending = {}

    @property
    def budget_exceeded(self):
        return getattr(self.inner, "budget_exceeded", False)

    def begin(self, task):
        self.pending = {}
        self.inner.begin(task)

    def decide(self, task, screen, hist):
        t = time.perf_counter()
        k = task.name + "|" + task.goal + "|" + screen.signature()
        want = self.store.get(k)
        if want:
            for a in screen.actions:
                if a.key() == want:
                    return {"id": a.id, "p": 1.0, "ms": (time.perf_counter() - t) * 1000, "src": "M"}
        d = self.inner.decide(task, screen, hist)
        self.pending[k] = screen.actions[d["id"]].key()
        return d

    def end(self, ok):
        if ok:
            self.store.update(self.pending)
            json.dump(self.store, open(self.path, "w"), indent=0)
        self.inner.end(ok)


def build_pilot(spec: str):
    kind, _, rest = spec.partition(":")
    if kind == "mlx":
        return MLXScorer(rest)
    if kind == "mlxid":
        return MLXScorer(rest, mode="id")
    if kind == "mlxL":
        return MLXLabelScorer(rest)
    if kind == "haiku":
        return HaikuPilot()
    if kind == "hybrid":
        path, tau = rest.rsplit(":", 1)
        return Hybrid(MLXScorer(path, mode="id"), HaikuPilot(), float(tau))
    if kind == "memory":
        inner_spec, _, store = rest.rpartition("@")
        return Memory(build_pilot(inner_spec), store)
    raise ValueError(spec)
