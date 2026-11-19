#!/usr/bin/env python3
"""coool's own notification sounds, synthesized (no samples, nothing downloaded).

    python3 -I app/scripts/sounds/make-sounds.py [out-dir]   # default: app/src-tauri/sounds
    python3 -I app/scripts/sounds/make-sounds.py --check [dir]

Each sound is a few sine partials (or a short FM pair) under an attack/decay envelope: 44.1 kHz, mono, 16-bit WAV,
0.2-0.8 s, starting and ending at silence (a raised-cosine fade at both ends, so no click). Loudness is set to about
-16 LUFS over the sounding part (an un-weighted RMS stand-in for LUFS, close enough for these short tonal sounds),
then lowered if needed so no peak goes over -3 dBFS. `--check` reads the files back and prints duration, peak, RMS
level, DC offset and the first and last samples, failing on anything out of bounds.

Characters (APP_SPEC "Notifications"): `rise` a soft two-note rise (needs you), `tap` a single low done tap (turn
finished), `glass` a glassy ping, `knock` a wooden knock, `marimba` a soft marimba note, `chirp` a tiny synth chirp,
`ticks` a subtle double tick.
"""

import math
import os
import struct
import sys
import wave

RATE = 44100
PEAK_DB = -3.0
TARGET_DB = -16.0
NAMES = ["rise", "tap", "glass", "knock", "marimba", "chirp", "ticks"]


def env(t, attack, decay):
    """Raised-cosine attack, then exponential decay with time constant `decay`."""
    a = 0.5 - 0.5 * math.cos(math.pi * t / attack) if t < attack else 1.0
    return a * math.exp(-max(0.0, t - attack) / decay)


def note(n, start, freq, partials, attack, decay, gain=1.0):
    """Adds a note at `start` s: `partials` is [(ratio, amplitude)], each partial decaying a little faster as it rises."""
    out = [0.0] * n
    s0 = int(start * RATE)
    for i in range(s0, n):
        t = (i - s0) / RATE
        v = 0.0
        for k, (ratio, amp) in enumerate(partials):
            v += amp * env(t, attack, decay / (1 + 0.6 * k)) * math.sin(2 * math.pi * freq * ratio * t)
        out[i] = gain * v
    return out


def mix(*tracks):
    return [sum(v) for v in zip(*tracks)]


def rise(n):
    # E5 then A5 (a fourth up), soft sine with a touch of octave: asks, gently.
    p = [(1, 1.0), (2, 0.18), (3, 0.05)]
    return mix(note(n, 0.0, 659.25, p, 0.012, 0.11), note(n, 0.15, 880.0, p, 0.012, 0.16))


def tap(n):
    # One low tap: a short FM body (A3) that settles fast.
    out = []
    for i in range(n):
        t = i / RATE
        idx = 1.6 * math.exp(-t / 0.03)
        v = math.sin(2 * math.pi * 220 * t + idx * math.sin(2 * math.pi * 440 * t))
        out.append(env(t, 0.004, 0.075) * v + 0.35 * env(t, 0.004, 0.05) * math.sin(2 * math.pi * 110 * t))
    return out


def glass(n):
    # A struck glass: G6 with the inharmonic partials of a free bar, long shimmer.
    return note(n, 0.0, 1567.98, [(1, 1.0), (2.76, 0.35), (5.4, 0.12), (8.93, 0.04)], 0.003, 0.22)


def knock(n):
    # Wood: two low inharmonic modes, very short, plus a faint filtered click of noise.
    body = note(n, 0.0, 190.0, [(1, 1.0), (2.3, 0.6), (4.1, 0.25)], 0.002, 0.035)
    seed, prev, noise = 12345, 0.0, []
    for i in range(n):
        seed = (1103515245 * seed + 12345) & 0x7FFFFFFF
        prev = 0.85 * prev + 0.15 * (seed / 0x3FFFFFFF - 1.0)
        noise.append(0.25 * prev * env(i / RATE, 0.001, 0.008))
    return mix(body, noise)


def marimba(n):
    # C5 with the marimba's tuned 4th and 10th partials, a soft mallet.
    return note(n, 0.0, 523.25, [(1, 1.0), (4.0, 0.22), (9.9, 0.05)], 0.004, 0.17)


def chirp(n):
    # A tiny synth chirp: a sine gliding up 900 -> 1500 Hz, then a short tail.
    out, ph = [], 0.0
    for i in range(n):
        t = i / RATE
        f = 900 + 600 * min(1.0, t / 0.09)
        ph += 2 * math.pi * f / RATE
        out.append(env(t, 0.008, 0.06) * (math.sin(ph) + 0.12 * math.sin(2 * ph)))
    return out


def ticks(n):
    # Two subtle ticks, the second a little softer.
    p = [(1, 1.0), (1.5, 0.3)]
    return mix(note(n, 0.0, 2093.0, p, 0.0015, 0.012), note(n, 0.085, 2093.0, p, 0.0015, 0.012, 0.75))


LENGTHS = {"rise": 0.55, "tap": 0.32, "glass": 0.75, "knock": 0.22, "marimba": 0.6, "chirp": 0.3, "ticks": 0.22}
MAKERS = {"rise": rise, "tap": tap, "glass": glass, "knock": knock, "marimba": marimba, "chirp": chirp, "ticks": ticks}


def finish(x):
    """No DC, faded to zero at both ends, loudness then peak set."""
    mean = sum(x) / len(x)
    x = [v - mean for v in x]
    fade_in, fade_out = int(0.002 * RATE), int(0.03 * RATE)
    for i in range(fade_in):
        x[i] *= 0.5 - 0.5 * math.cos(math.pi * i / fade_in)
    for i in range(fade_out):
        x[-1 - i] *= 0.5 - 0.5 * math.cos(math.pi * i / fade_out)
    x[0] = x[-1] = 0.0
    # Loudness over the sounding part (within 40 dB of the peak).
    pk = max(abs(v) for v in x)
    active = [v for v in x if abs(v) > pk * 0.01] or x
    rms = math.sqrt(sum(v * v for v in active) / len(active))
    g = 10 ** (TARGET_DB / 20) / rms
    g = min(g, 10 ** (PEAK_DB / 20) / pk)
    return [v * g for v in x]


def write(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(round(max(-1.0, min(1.0, v)) * 32767))) for v in x))


def check(path):
    with wave.open(path, "rb") as w:
        rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        x = [s[0] / 32768 for s in struct.iter_unpack("<h", w.readframes(n))]
    dur = n / rate
    pk = max(abs(v) for v in x)
    pk_db = 20 * math.log10(pk)
    active = [v for v in x if abs(v) > pk * 0.01]
    rms_db = 20 * math.log10(math.sqrt(sum(v * v for v in active) / len(active)))
    dc = sum(x) / n
    bad = []
    if (rate, ch, width) != (RATE, 1, 2):
        bad.append("format")
    if not 0.2 <= dur <= 0.8:
        bad.append("duration")
    if pk_db > PEAK_DB + 0.05:
        bad.append("peak")
    if abs(dc) > 1e-3:
        bad.append("dc")
    if abs(x[0]) > 1e-3 or abs(x[-1]) > 1e-3:
        bad.append("ends")
    print(f"{os.path.basename(path):<18} {dur:.3f} s  peak {pk_db:6.2f} dBFS  rms {rms_db:6.2f} dBFS  dc {dc:+.6f}  first {x[0]:+.4f} last {x[-1]:+.4f}  {'OK' if not bad else 'BAD ' + ','.join(bad)}")
    return not bad


def main():
    args = sys.argv[1:]
    here = os.path.dirname(os.path.abspath(__file__))
    default = os.path.normpath(os.path.join(here, "..", "..", "src-tauri", "sounds"))
    if args and args[0] == "--check":
        d = args[1] if len(args) > 1 else default
        ok = all([check(os.path.join(d, f"coool-{n}.wav")) for n in NAMES])
        sys.exit(0 if ok else 1)
    d = args[0] if args else default
    os.makedirs(d, exist_ok=True)
    for name in NAMES:
        n = int(LENGTHS[name] * RATE)
        write(os.path.join(d, f"coool-{name}.wav"), finish(MAKERS[name](n)))
    print(f"wrote {len(NAMES)} sounds to {d}")


if __name__ == "__main__":
    main()
