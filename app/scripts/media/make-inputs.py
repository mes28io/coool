"""Invented still files for the media e2e (app/scripts/media-e2e.sh): a bar chart PNG, a one-page PDF, a small
picture kept outside the chat's folder, and a page for the Browser panel. Run with `python3 -I`.

    python3 -I make-inputs.py <folder> <outside folder>
"""

import struct
import sys
import zlib
from pathlib import Path


def png(path, w, h, pixel):
    rows = b"".join(b"\0" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def chart(x, y):
    bars = [0.42, 0.58, 0.35, 0.8, 0.66, 0.92, 0.51]
    w, h = 640, 400
    bg = (18 + y * 20 // h, 24 + y * 24 // h, 42 + y * 30 // h)
    for i, v in enumerate(bars):
        x0 = 50 + i * 82
        if x0 <= x < x0 + 56 and h - 40 - int(v * 300) <= y < h - 40:
            return (90 + i * 20, 160, 255 - i * 18) if i != 5 else (255, 196, 70)
    if y == h - 40 and 30 <= x < w - 30:
        return (120, 130, 150)
    return bg


def pdf(path):
    content = "BT /F1 40 Tf 60 700 Td (Spec: alert sounds) Tj ET 0.2 0.45 1 rg 60 420 480 200 re f 0 0 0 rg BT /F1 18 Tf 60 380 Td (Page one of one) Tj ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n"
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010} 00000 n \n" for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF"
    Path(path).write_text(out)


# An explainer as an agent would make one: a request moving through three boxes (CSS animation), plus a probe of
# what its sandbox lets it do, posted to the chat for the self-test (`cooolProbe`).
EXPLAINER = """<!doctype html><html><head><meta charset="utf-8"><title>How a request flows</title><style>
body{margin:0;font:14px -apple-system,sans-serif;color:#d8dde6;background:#14171c;padding:18px}
h3{margin:0 0 14px;font-weight:600}.row{display:flex;gap:28px;align-items:center;position:relative;height:120px}
.box{width:120px;height:64px;border-radius:12px;background:#222833;border:1px solid #39414f;display:flex;align-items:center;justify-content:center}
.dot{position:absolute;left:52px;top:52px;width:16px;height:16px;border-radius:50%;background:#4f8cff;animation:go 3s ease-in-out infinite}
@keyframes go{0%{transform:translateX(0)}45%{transform:translateX(148px)}90%,100%{transform:translateX(296px)}}
p{color:#8b93a1;margin:14px 0 0}</style></head><body><h3>How a request flows</h3>
<div class="row"><div class="box">Client</div><div class="box">API</div><div class="box">Queue</div><span class="dot"></span></div>
<p>The request is accepted by the API, then queued; the worker picks it up later.</p>
<script>
(async function(){var r={};
try{await fetch("https://example.com/");r.fetch="loaded"}catch(e){r.fetch="blocked"}
try{r.parent=parent.document?"readable":"none"}catch(e){r.parent="blocked"}
try{localStorage.setItem("x","1");r.storage="usable"}catch(e){r.storage="blocked"}
var t=window.__TAURI_INTERNALS__;
if(!t||!t.invoke)r.ipc="absent";else{try{await t.invoke("media_grant",{chat:0,session:null,paths:["/etc/hosts"]});r.ipc="answered"}catch(e){r.ipc="refused"}}
var img=new Image();r.img=await new Promise(function(ok){img.onload=function(){ok("loaded")};img.onerror=function(){ok("blocked")};img.src="https://example.com/favicon.ico";setTimeout(function(){ok("blocked")},3000)});
parent.postMessage({cooolProbe:r},"*")})();
</script></body></html>"""
SVG = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120" width="400" height="120">
<rect width="400" height="120" rx="14" fill="#14171c"/>
<circle cx="60" cy="60" r="16" fill="#ffb347"><animate attributeName="cx" values="60;340;60" dur="2.4s" repeatCount="indefinite"/></circle>
<text x="200" y="110" fill="#8b93a1" font-family="-apple-system" font-size="12" text-anchor="middle">retry loop</text></svg>"""

folder, outside = Path(sys.argv[1]), Path(sys.argv[2])
(folder / "out").mkdir(parents=True, exist_ok=True)
(folder / "docs").mkdir(parents=True, exist_ok=True)
outside.mkdir(parents=True, exist_ok=True)
png(folder / "out" / "chart.png", 640, 400, chart)
png(outside / "hidden.png", 48, 48, lambda x, y: (200, 30, 30))
pdf(folder / "docs" / "spec.pdf")
(folder / "out" / "flow.html").write_text(EXPLAINER)
(folder / "out" / "loop.svg").write_text(SVG)
(folder / "out" / "page.html").write_text("<!doctype html><title>Alerts</title><body style='font:16px -apple-system;padding:40px;background:#f4f6fa'><h1>Alerts</h1><p>Three new sounds.</p><button>Play</button></body>")
