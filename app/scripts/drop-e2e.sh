#!/bin/sh
# File drops from Finder in the real app, no model, no network, no account (the stand-in Claude CLI of
# app/scripts/readme-shots). Two self-test scenarios (app/src/selftestAttach.ts), one launch each:
#
# - `attach-native-drop`: through the native path (app/src-tauri/src/selftest/drag.rs). The view that takes a file
#   drag at the point, found in the window's real view tree as AppKit finds it, must be the app's WKWebView; the test's
#   own NSDraggingInfo (the files on a private pasteboard) goes to its dragging-destination methods, so wry reads the
#   pasteboard and the location as for Finder's drag and Tauri's drag events reach the page. A plain chat, the browser
#   panel open and closed, the New session sheet, and after a reload.
# - `attach-gestures`: Tauri's drag events emitted directly (skipping AppKit and wry), a paste, the PDF preview.
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/drop-e2e.sh
#
# Everything lives under $DROP_ROOT (default /private/tmp/coool-host-drop-e2e): a throwaway HOME, the test folder and
# its inputs, the attachment store, the chat host's folder, logs and screenshots. The window stays off screen
# (COOOL_SELFTEST_BACKGROUND=1), no menu bar item; the pointer and the system's drag pasteboard are never touched.
# Only this run's processes are stopped.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${DROP_ROOT:-/private/tmp/coool-host-drop-e2e}
case "$ROOT" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "DROP_ROOT must be under /tmp/coool-host-"; exit 1 ;; esac
NAME=coool-drop-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }

rm -rf "$ROOT"
H="$ROOT/home"
W="$H/code/drops"
IN="$H/code/attach-inputs"
HOSTDIR="$ROOT/host"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs" "$ROOT/store" "$W" "$IN"
echo '{}' > "$W/.mcp.json"
echo '# drops' > "$W/README.md"
# The inputs, beside the test folder: an invented picture (a red square on white), a text file and a one-page PDF
# (a black square on white).
python3 -I -c '
import struct, sys, zlib
w = h = 64
rows = b"".join(b"\0" + b"".join(b"\xff\x20\x20" if 16 <= x < 48 and 16 <= y < 48 else b"\xff\xff\xff" for x in range(w)) for y in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1] + "/shape.png", "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
draw = b"0 0 0 rg 100 300 400 400 re f"
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(draw) + draw + b"\nendstream"]
pdf, offs = b"%PDF-1.4\n", []
for i, o in enumerate(objs):
    offs.append(len(pdf))
    pdf += b"%d 0 obj\n" % (i + 1) + o + b"\nendobj\n"
x = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
open(sys.argv[1] + "/spec.pdf", "wb").write(pdf)
' "$IN"
printf 'Dropped notes\nCode word: periwinkle-42\n' > "$IN/notes.txt"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

ok=1
run() { # <scenario>
  LOG="$ROOT/logs/$1.log"
  mkdir -p "$ROOT/shots/$1"
  env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
    PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin" COOOL_MENUBAR_HIDDEN=1 \
    COOOL_SELFTEST="$1" COOOL_SELFTEST_DIR="$W" COOOL_SELFTEST_SHOTS="$ROOT/shots/$1" COOOL_SELFTEST_LOG="$LOG" \
    COOOL_SELFTEST_BACKGROUND=1 COOOL_ATTACH_DIR="$ROOT/store" COOOL_CHAT_HOST_DIR="$HOSTDIR" \
    "$ROOT/app/$NAME" >> "$ROOT/logs/app.out" 2>&1 &
  APP=$!
  i=0
  while [ $i -lt 240 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
    if ! kill -0 $APP 2>/dev/null; then echo "$1: the app exited early (see $ROOT/logs/app.out)"; break; fi
    sleep 1
    i=$((i + 1))
  done
  kill $APP 2>/dev/null || true
  wait $APP 2>/dev/null || true
  echo "--- $1"
  grep -E 'PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"
  if grep -q 'FAIL' "$LOG" || ! grep -q 'SUMMARY pass=[1-9]' "$LOG"; then ok=0; fi
}

run attach-native-drop
run attach-gestures

# The host this run started (its folder is ours): by pid, from its own file.
for f in "$HOSTDIR"/*.json; do
  [ -f "$f" ] || continue
  hp=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$f" | head -1)
  if [ -n "$hp" ] && ps -o command= -p "$hp" 2>/dev/null | grep -q -- "--coool-chat-host $HOSTDIR"; then kill "$hp" 2>/dev/null || true; fi
done
# The stand-in CLIs end shortly after their pipes close; any left are this run's own (their path is under $ROOT).
i=0
while [ $i -lt 10 ] && ps -axo command= | grep -F "$ROOT/" | grep -qv grep; do sleep 1; i=$((i + 1)); done
for p in $(ps -axo pid=,command= | grep -F "$ROOT/" | grep -v grep | awk '{print $1}'); do kill "$p" 2>/dev/null || true; done
echo "shots: $ROOT/shots"
[ $ok = 1 ]
