#!/bin/sh
# Runs perf-* self-test scenarios against a HOME made by make-home.py (docs/PERF.md): that HOME for session and
# app data, the window out of sight and never focused (COOOL_SELFTEST_OFFSCREEN=1; PERF_OFFSCREEN=0 puts it on screen).
#
#   app/scripts/perf/run.sh <out> <scenarios> [live-sessions]
#
# <out>: the folder make-home.py filled. <scenarios>: e.g. perf-boot or perf-idle,perf-long. [live-sessions]: start
# replay.py with that many busy, writing sessions for the run. COOOL_BIN: the self-test build (default
# $CARGO_TARGET_DIR/debug/coool). Prints the PERF lines; the full log stays in <out>/logs/.
set -eu
OUT=$(cd "$1" && pwd -P)
SC=$2
K=${3:-0}
HERE=$(cd "$(dirname "$0")" && pwd -P)
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-target}/debug/coool}
mkdir -p "$OUT/logs" "$OUT/shots" "$OUT/bin"
# A copy with a name of its own: WebKit keeps an unbundled binary's web data under ~/Library/WebKit/<name>
# (remove ~/Library/WebKit/coool-perf and ~/Library/Caches/coool-perf when done).
cp "$BIN" "$OUT/bin/coool-perf"
BIN="$OUT/bin/coool-perf"
LOG="$OUT/logs/$(date +%Y%m%d-%H%M%S)-$(echo "$SC" | tr ',' '+')-k$K.log"
RP=""
if [ "$K" -gt 0 ]; then
  python3 -I "$HERE/replay.py" --out "$OUT" --sessions "$K" --rate 3 --secs 1800 > "$OUT/logs/replay.pid" &
  RP=$!
  sleep 2
fi
HOME="$OUT/home" COOOL_SELFTEST_OFFSCREEN=${PERF_OFFSCREEN:-1} COOOL_SELFTEST="$SC" COOOL_SELFTEST_DIR="$OUT/proj" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_SHOTS="$OUT/shots" "$BIN" > "$OUT/logs/app.out" 2>&1 &
APP=$!
# Wait for the scenarios to finish (at most 30 min), then stop the app and the writer by pid.
i=0
while [ $i -lt 1800 ] && ! grep -q '^.* END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then
    st=0
    wait $APP || st=$?
    echo "app exited early with status $st (see $OUT/logs/app.out)"
    break
  fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
if [ -n "$RP" ]; then kill $RP 2>/dev/null || true; wait $RP 2>/dev/null || true; fi
grep -E 'PERF|FAIL|SUMMARY' "$LOG" || cat "$LOG"
echo "log: $LOG"
