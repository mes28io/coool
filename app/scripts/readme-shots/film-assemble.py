#!/usr/bin/env python3
"""Turns the film scenario's bursts into footage (film.sh runs it).

    python3 -I film-assemble.py --shots <root>/shots --log <root>/logs/selftest.log --out launch-video/footage

For each burst <shots>/film-<name>/ (stills named <ms since the burst began>-<worker>.png):
  <name>.mp4            constant 30 fps, H.264 (CRF 12, 4:2:0), the window's own pixels (2880x1800 on a retina
                        display); each output frame shows the newest still captured by its time, so a frame repeats
                        where the capture was slower than 1/30 s
  <name>-<label>.png    the still nearest 0.4 s after each FILMMARK (the moment, settled)
  <name>-<label>-<element>.png   that still cropped to an element the mark named (the UI as an object), with 24 px
                        (CSS) of margin
  terminal-*.json       what a terminal running the `terminal` / `terminal-codex` sessions would show (seconds after
                        the cue, line), for a terminal drawn beside the app
  <name>.json           the burst's cues (seconds into the video), its real capture rate (frames, mean / p95 / max gap) and each mark's time in the video
                        with its elements' rectangles in video pixels
"""

import argparse
import json
import re
import shutil
import statistics
import subprocess
from pathlib import Path

SCALE = 2  # CSS px -> window pixels (retina)
MARGIN = 24


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    shots, out = Path(a.shots), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    starts, marks, cues = {}, {}, []
    for line in Path(a.log).read_text().splitlines():
        p = line.split(" ", 3)
        if len(p) >= 4 and p[1] == "FILM" and p[2] == "start":
            starts[p[3].split()[0]] = float(p[0])
        c = re.match(r"^(\S+) CUE (\S+)$", line)
        if c:
            cues.append((float(c.group(1)), c.group(2)))
        m = re.match(r"^(\S+) FILMMARK (\S+) (\S+) (.*)$", line)
        if m:
            marks.setdefault(m.group(2), []).append((float(m.group(1)), m.group(3), json.loads(m.group(4))))
    terminals(shots.parent, out)
    for d in sorted(shots.glob("film-*")):
        name = d.name[len("film-"):]
        if name.startswith("m-") or (a.only and name not in a.only.split(",")):
            continue
        frames = sorted(((int(f.stem.split("-")[0]) / 1000, f) for f in d.glob("*.png")), key=lambda x: x[0])
        if len(frames) < 2:
            continue
        gaps = [b[0] - a_[0] for a_, b in zip(frames, frames[1:])]
        lst = d / "concat.txt"
        with open(lst, "w") as f:
            for (t, p), g in zip(frames, gaps + [1 / 30]):
                f.write(f"file '{p}'\nduration {g:.4f}\n")
            f.write(f"file '{frames[-1][1]}'\n")
        mp4 = out / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", "fps=30", "-fps_mode", "cfr",
                        "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)], check=True)
        t0 = starts.get(name)
        info = {"file": mp4.name, "frames_captured": len(frames), "seconds": round(frames[-1][0], 2),
                "real_fps": round((len(frames) - 1) / frames[-1][0], 1), "gap_ms": {"mean": round(statistics.mean(gaps) * 1000), "p95": round(sorted(gaps)[int(len(gaps) * 0.95)] * 1000), "max": round(max(gaps) * 1000)},
                "marks": []}
        for at, label, rects in marks.get(name, []):
            t = at - t0 if t0 else 0
            want = t + 0.4
            still = min(frames, key=lambda x: abs(x[0] - want))[1]
            png = out / f"{name}-{label}.png"
            shutil.copy(still, png)
            px = {k: [v * SCALE for v in r] if r else None for k, r in rects.items()}
            info["marks"].append({"label": label, "t": round(t, 2), "still": png.name, "rects_px": px})
            for k, r in px.items():
                if not r or r[2] < 8 or r[3] < 8:
                    continue
                x, y, w, h = r
                m = MARGIN * SCALE
                x0, y0 = max(0, x - m), max(0, y - m)
                crop = out / f"{name}-{label}-{k}.png"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(png), "-vf", f"crop={w + 2 * m}:{h + 2 * m}:{x0}:{y0}:exact=1", str(crop)], check=False)
        if t0:
            info["cues"] = [{"cue": n, "t": round(at - t0, 2)} for at, n in cues if 0 <= at - t0 <= frames[-1][0]]
        (out / f"{name}.json").write_text(json.dumps(info, indent=1))
        print(f"{mp4.name}: {info['seconds']} s, {len(frames)} stills, {info['real_fps']} fps real, gaps {info['gap_ms']}")


def terminals(root: Path, out: Path):
    """What a terminal would have shown for the `terminal` / `terminal-codex` cues (seconds after the cue, line)."""
    for p in root.glob("terminal-*.json"):
        shutil.copy(p, out / p.name)


if __name__ == "__main__":
    main()
