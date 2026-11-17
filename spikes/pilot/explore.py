"""Tiny CLI to poke the device: python explore.py <udid-file> <bundle|-> [action-substring ...]"""
import sys
import time

import device
from device import Device

d = Device(open(sys.argv[1]).read().strip())
args = sys.argv[2:]
if args and args[0] != "-":
    d.start(args[0])
    time.sleep(1.0)
else:
    d.sid = device._req("GET", "/status")["sessionId"]
for sub in args[1:]:
    s = d.perceive({"text": "hello"})
    want, _, text = sub.partition("=")
    a = next(a for a in s.actions if want.lower() in a.describe().lower())
    print(">>", a.describe())
    d.act(a, {"text": text})
    time.sleep(0.8)
s = d.perceive({"text": "x"})
print(f"source {s.raw_ms:.0f}ms  sig {s.signature()}")
print(s.render())
