#!/bin/sh
# Runs the `perf-changes` self-test scenario (docs/PERF.md "Changes view") against a case made by
# make-changes-home.py, out of sight (COOOL_SELFTEST_OFFSCREEN=1). When the log says LIVE-START it starts the live
# writer (a working terminal session editing files), on LIVE-STOP it stops it.
#
#   python3 -I app/scripts/perf/make-changes-home.py make --out <out>
#   COOOL_BIN=<debug build> sh app/scripts/perf/changes-run.sh <out>
#
# The binary is copied as <out>/bin/coool-chperf (PERF_NAME for another name): remove ~/Library/WebKit/<name> and
# ~/Library/Caches/<name> after. Prints the PERF lines; the log stays in <out>/logs/.
set -eu
OUT=$(cd "$1" && pwd -P)
HERE=$(cd "$(dirname "$0")" && pwd -P)
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-target}/debug/coool}
NAME=${PERF_NAME:-coool-chperf}
mkdir -p "$OUT/logs" "$OUT/shots" "$OUT/bin"
cp "$BIN" "$OUT/bin/$NAME"
LOG="$OUT/logs/$(date +%Y%m%d-%H%M%S)-perf-changes.log"
HOME="$OUT/home" COOOL_SELFTEST_OFFSCREEN=${PERF_OFFSCREEN:-1} COOOL_SELFTEST="${SCENARIO:-perf-changes}" \
  COOOL_SELFTEST_DIR="$OUT/proj" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_SHOTS="$OUT/shots" "$OUT/bin/$NAME" > "$OUT/logs/app.out" 2>&1 &
APP=$!
LP=""
i=0
while [ $i -lt 1800 ] && ! grep -q '^.* END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then
    echo "app exited early (see $OUT/logs/app.out)"
    break
  fi
  if [ -z "$LP" ] && grep -q 'LIVE-START' "$LOG" 2>/dev/null; then
    python3 -I "$HERE/make-changes-home.py" live --out "$OUT" --rate 4 --edit-every 20 --secs 900 > "$OUT/logs/live.pid" &
    LP=$!
  fi
  if [ -n "$LP" ] && [ "$LP" != done ] && grep -q 'LIVE-STOP' "$LOG" 2>/dev/null; then
    kill $LP 2>/dev/null || true
    wait $LP 2>/dev/null || true
    LP=done
  fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
if [ -n "$LP" ] && [ "$LP" != done ]; then kill $LP 2>/dev/null || true; wait $LP 2>/dev/null || true; fi
grep -E 'PERF|FAIL|SUMMARY' "$LOG" || cat "$LOG"
echo "log: $LOG"
