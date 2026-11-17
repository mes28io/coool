"""Device layer for the pilot spike: WebDriverAgent over localhost HTTP.

perceive() -> Screen (flattened AX tree -> typed candidate actions)
act(Action) -> performs it, returns device ms.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.request
from dataclasses import dataclass, field, asdict

WDA = "http://127.0.0.1:8123"

TAPPABLE = {"Button", "Cell", "Switch", "Link", "TextField", "SecureTextField",
            "SearchField", "Tab", "SegmentedControl", "MenuItem", "TextView", "Key", "Slider",
            "Image", "Icon"}
TEXT_INPUT = {"TextField", "SecureTextField", "SearchField"}


def _req(method: str, path: str, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(WDA + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def _frame(s: str):
    nums = [float(x) for x in re.findall(r"-?[\d.]+", s or "")]
    return tuple(nums[:4]) if len(nums) >= 4 else (0, 0, 0, 0)


@dataclass
class Element:
    type: str
    label: str
    value: str | None
    frame: tuple
    ident: str | None = None

    @property
    def center(self):
        x, y, w, h = self.frame
        return (x + w / 2, y + h / 2)

    def describe(self) -> str:
        s = f'{self.type} "{self.label}"'
        v = self.value
        if self.type == "Switch" and v in ("0", "1"):
            s += " (on)" if v == "1" else " (off)"
        elif self.type == "Button" and v == "1":
            s += " (selected)"
        elif self.type in TEXT_INPUT and v not in (None, ""):
            s += f" containing {v.replace(chr(0x200e), '')!r}" if v != self.label else ""
        elif v not in (None, "", self.label, "0"):
            s += f" = {v!r}"
        return s


@dataclass
class Action:
    verb: str                 # tap | type | submit | scroll_down | scroll_up | done | stuck
    target: Element | None = None
    text_key: str | None = None   # for type: which goal input to type
    id: int = -1

    def describe(self) -> str:
        if self.verb == "tap":
            return f"tap {self.target.describe()}"
        if self.verb == "type":
            return f"type <{self.text_key}> into {self.target.describe()}"
        return {"submit": "press the keyboard Return/Search/Go key",
                "scroll_down": "scroll down", "scroll_up": "scroll up",
                "back": "go back (swipe from left edge)",
                "done": "done: the goal is achieved",
                "stuck": "stuck: cannot make progress, ask for help"}[self.verb]

    def key(self) -> str:
        """Stable, coordinate-free identity used by muscle memory."""
        if self.target is None:
            return self.verb
        return f"{self.verb}|{self.target.type}|{self.target.label}|{self.text_key or ''}"


@dataclass
class Screen:
    app: str
    elements: list[Element]
    texts: list[str]
    actions: list[Action]
    keyboard: bool
    raw_ms: float = 0.0

    def signature(self) -> str:
        sig = "|".join(sorted(a.key() + "=" + str(a.target.value if a.target else "") for a in self.actions))
        return hashlib.sha1((self.app + sig).encode()).hexdigest()[:16]

    def layout_signature(self) -> str:
        """Coarser signature for change detection (ignores values)."""
        sig = "|".join(sorted(a.key() for a in self.actions))
        return hashlib.sha1((self.app + sig).encode()).hexdigest()[:16]

    def render(self, max_texts=25) -> str:
        lines = [f"App: {self.app}" + ("  (keyboard is up)" if self.keyboard else "")]
        if self.texts:
            lines.append("Visible text: " + " | ".join(self.texts[:max_texts]))
        lines.append("Actions:")
        for a in self.actions:
            lines.append(f"[{a.id}] {a.describe()}")
        return "\n".join(lines)


class Device:
    def __init__(self, udid: str, width=402, height=874):
        self.udid = udid
        self.w, self.h = width, height
        self.sid = None

    # ---- session / apps
    def start(self, bundle: str):
        t = time.perf_counter()
        if self.sid is None:
            r = _req("POST", "/session", {"capabilities": {"alwaysMatch": {"bundleId": bundle, "shouldWaitForQuiescence": False}}})
            self.sid = r["sessionId"]
            _req("POST", f"/session/{self.sid}/appium/settings", {"settings": {
                "animationCoolOffTimeout": 0, "waitForIdleTimeout": 0, "reduceMotion": True,
                "snapshotMaxDepth": 60}})
        else:
            _req("POST", f"/session/{self.sid}/wda/apps/launch", {"bundleId": bundle})
        return (time.perf_counter() - t) * 1000

    def terminate(self, bundle: str):
        try:
            _req("POST", f"/session/{self.sid}/wda/apps/terminate", {"bundleId": bundle})
        except Exception:
            pass

    # ---- perceive
    def source(self):
        return _req("GET", f"/session/{self.sid}/source?format=json")["value"]

    def alert(self):
        try:
            txt = _req("GET", f"/session/{self.sid}/alert/text", timeout=5)["value"]
            btns = _req("GET", f"/session/{self.sid}/wda/alert/buttons", timeout=5)["value"]
            return txt, btns
        except Exception:
            return None

    def perceive(self, inputs: dict | None = None) -> Screen:
        t = time.perf_counter()
        al = self.alert()
        if al:
            txt, btns = al
            acts = [Action("tap", Element("AlertButton", b, None, (0, 0, 0, 0))) for b in btns]
            acts += [Action("done"), Action("stuck")]
            for i, a in enumerate(acts):
                a.id = i
            scr = Screen("System alert", [a.target for a in acts if a.target], [txt[:200]], acts, False)
            scr.raw_ms = (time.perf_counter() - t) * 1000
            return scr
        tree = self.source()
        raw_ms = (time.perf_counter() - t) * 1000
        scr = build_screen(tree, inputs or {}, self.w, self.h)
        scr.raw_ms = raw_ms
        self.kb_top = scr.keyboard
        return scr

    # ---- act
    def tap(self, x, y):
        _req("POST", f"/session/{self.sid}/wda/tap", {"x": x, "y": y})

    def keys(self, text: str):
        _req("POST", f"/session/{self.sid}/wda/keys", {"value": list(text), "frequency": 60})

    def drag(self, x1, y1, x2, y2, dur=0.15):
        _req("POST", f"/session/{self.sid}/wda/dragfromtoforduration",
             {"fromX": x1, "fromY": y1, "toX": x2, "toY": y2, "duration": dur})

    kb_top = None

    def act(self, a: Action, inputs: dict) -> float:
        t = time.perf_counter()
        if a.verb == "tap" and a.target.type == "AlertButton":
            _req("POST", f"/session/{self.sid}/alert/accept", {"name": a.target.label})
        elif a.verb == "tap":
            self.tap(*a.target.center)
        elif a.verb == "type":
            el = a.target
            if not el.value or el.value == el.label or True:
                self.tap(*el.center)
            self.keys(str(inputs[a.text_key]))
        elif a.verb == "submit":
            self.keys("\n")
        elif a.verb in ("scroll_down", "scroll_up"):
            lo, hi = (0.15, 0.45) if self.kb_top else (0.3, 0.7)
            ys = (self.h * hi, self.h * lo) if a.verb == "scroll_down" else (self.h * lo, self.h * hi)
            self.drag(self.w / 2, ys[0], self.w / 2, ys[1], 0.5)
            time.sleep(0.6)  # let momentum die: a tap during deceleration only stops the scroll
        elif a.verb == "back":
            self.drag(2, self.h / 2, self.w * 0.8, self.h / 2, 0.2)
        return (time.perf_counter() - t) * 1000


def build_screen(tree: dict, inputs: dict, W: int, H: int) -> Screen:
    app = tree.get("label") or "?"
    els: list[Element] = []
    texts: list[str] = []
    keyboard = False
    seen_frames = {}

    kb_top = [H]

    def find_kb(n):
        if n.get("type") == "Keyboard":
            kb_top[0] = _frame(n.get("frame"))[1]
        for ch in n.get("children") or []:
            find_kb(ch)
    find_kb(tree)

    def visible(fr):
        x, y, w, h = fr
        cx, cy = x + w / 2, y + h / 2
        return w > 2 and h > 2 and 0 < cx < W and 0 < cy < min(kb_top[0], H - 30)

    def walk(n, inside_tappable=False):
        nonlocal keyboard
        t = n.get("type")
        if t == "Keyboard":
            keyboard = True
            return  # don't enumerate keys
        fr = _frame(n.get("frame"))
        label = (n.get("label") or n.get("name") or "").strip()
        if t in TEXT_INPUT and not (n.get("label") or "").strip():
            ph = n.get("placeholderValue") or ""
            label = " ".join(dict.fromkeys(x for x in (n.get("name") or "", ph) if x)).strip()
        val = n.get("value")
        if val is not None and val == n.get("placeholderValue"):
            val = None
        vis = visible(fr) and n.get("isVisible") == "1"
        tappable = t in TAPPABLE and vis and (label or t in TEXT_INPUT) and n.get("isEnabled") == "1"
        if t in ("Image", "Icon") and not ("Button" in (n.get("traits") or "")):
            tappable = False
        if tappable and re.fullmatch(r"[A-Za-z]+\.[A-Za-z.]+|[A-Za-z]+(Identifier|Content|View|Cell)[\w-]*", label):
            tappable = False  # developer identifiers, not user-facing labels
        if tappable and t == "Cell" and not label:
            tappable = False
        if tappable:
            key = (round(fr[0]), round(fr[1]), round(fr[2]), round(fr[3]))
            prev = seen_frames.get(key)
            if prev is None or (prev.label != label):
                e = Element(t, label[:80], (str(val)[:60] if val is not None else None), fr, n.get("name"))
                els.append(e)
                seen_frames[key] = e
        elif t == "StaticText" and vis and label and not inside_tappable:
            if label not in texts:
                texts.append(label[:80])
        for ch in n.get("children") or []:
            walk(ch, inside_tappable or tappable)

    walk(tree)
    # collapse duplicates: same normalized label (and same input-ness) with overlapping frames,
    # e.g. a Cell wrapping a Button with the same label
    def norm(e):
        return (e.type in TEXT_INPUT, re.sub(r"[^a-z0-9]", "", e.label.lower()))

    def overlaps(a, b):
        (ax, ay), (bx, by, bw, bh) = a.center, b.frame
        (cx, cy), (dx, dy, dw, dh) = b.center, a.frame
        return (bx <= ax <= bx + bw and by <= ay <= by + bh) or (dx <= cx <= dx + dw and dy <= cy <= dy + dh)

    uniq: list[Element] = []
    for e in els:
        if any(norm(u) == norm(e) and norm(e)[1] and overlaps(u, e) for u in uniq):
            continue
        uniq.append(e)
    acts: list[Action] = []
    for e in uniq:
        if e.type in TEXT_INPUT and inputs:
            for k in inputs:   # typing taps the field first, so no separate tap candidate
                acts.append(Action("type", e, k))
        else:
            acts.append(Action("tap", e))
    if keyboard:
        acts.append(Action("submit"))
    acts += [Action("scroll_down"), Action("scroll_up"), Action("back"), Action("done"), Action("stuck")]
    for i, a in enumerate(acts):
        a.id = i
    return Screen(app, uniq, texts, acts, keyboard)
