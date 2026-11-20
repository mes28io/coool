#!/bin/sh
# The `portrait` self-test (app/src/selftestPortrait.ts): the real app on the invented workspace of run.sh, its window
# 1080 x 1920 (a 22-inch monitor turned to portrait), then resized to landscape and back. No model calls.
#
#   COOOL_BIN=<debug build of the current frontend> sh app/scripts/readme-shots/portrait.sh
#
# PORTRAIT_ROOT (default /private/tmp/coool-portrait-selftest) holds the throwaway HOME, the log and the shots
# (real-portrait-*.png); PORTRAIT_SIZE (default 1080x1920) is the window's starting size. As with run.sh, nothing
# reads or writes the real ~/.claude or ~/.codex, and the window stays off screen and never takes focus. PORTRAIT_OUT,
# if set, gets a copy of the shots and the log; the root and the binary's WebKit data are removed afterwards unless
# PORTRAIT_KEEP=1.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ROOT=${PORTRAIT_ROOT:-/private/tmp/coool-portrait-selftest}
NAME=coool-portrait-selftest
SIZE=${PORTRAIT_SIZE:-1080x1920}
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.coool-readme-shots" ] || { echo "$ROOT exists and isn't ours; remove it or set PORTRAIT_ROOT"; exit 1; }
  rm -rf "$ROOT"
fi
python3 -I "$HERE/workspace.py" build --root "$ROOT"
touch "$ROOT/.coool-readme-shots"
cp "$HERE/standin-claude.py" "$ROOT/bin/claude"
printf '#!/bin/sh\nexit 1\n' > "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
mkdir -p "$ROOT/app" "$ROOT/shots" "$ROOT/logs"
cp "$BIN" "$ROOT/app/$NAME"
H="$ROOT/home"
case "$H" in /Users/*) echo "refusing a HOME under /Users"; exit 1 ;; esac
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

python3 -I "$HERE/workspace.py" live --root "$ROOT" > "$ROOT/logs/live.pid" 2> "$ROOT/logs/live.err" &
LIVE=$!
sleep 1

LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST=portrait COOOL_SELFTEST_SIZE="$SIZE" COOOL_SELFTEST_DIR="$H/code" COOOL_SELFTEST_SHOTS="$ROOT/shots" \
  COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_BACKGROUND=1 \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

i=0
while [ $i -lt 400 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
kill $LIVE 2>/dev/null || true
wait $LIVE 2>/dev/null || true
grep -E 'PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"
ok=0
grep -q 'SUMMARY pass=[0-9]* fail=0' "$LOG" && ok=1
if [ -n "${PORTRAIT_OUT:-}" ]; then
  mkdir -p "$PORTRAIT_OUT"
  cp "$ROOT"/shots/*.png "$LOG" "$PORTRAIT_OUT"/ 2>/dev/null || true
  echo "shots and log copied to $PORTRAIT_OUT"
fi
if [ "${PORTRAIT_KEEP:-0}" != 1 ]; then
  rm -rf "$ROOT" "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
fi
[ $ok = 1 ]
