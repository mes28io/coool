#!/bin/sh
# The `menubar` self-test (app/src/selftestMenubar.ts): the menu bar item in the real app on the invented workspace of
# run.sh, created hidden (nothing is drawn in the menu bar). No model calls. MENUBAR_LIVE=0 runs it without the live
# sessions (workspace.py live), so that nothing else waits and the needs-you mark is seen to go away too.
#
#   COOOL_BIN=<debug build of the current frontend> sh app/scripts/readme-shots/menubar.sh
#
# MENUBAR_ROOT (default /private/tmp/coool-menubar-selftest) holds the throwaway HOME and the log. As with run.sh,
# nothing reads or writes the real ~/.claude or ~/.codex, and the window stays off screen and never takes focus.
# MENUBAR_OUT, if set, gets a copy of the log; the root and the binary's WebKit data are removed afterwards unless
# MENUBAR_KEEP=1.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ROOT=${MENUBAR_ROOT:-/private/tmp/coool-menubar-selftest}
NAME=coool-menubar-selftest
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.coool-readme-shots" ] || { echo "$ROOT exists and isn't ours; remove it or set MENUBAR_ROOT"; exit 1; }
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

LIVE=
if [ "${MENUBAR_LIVE:-1}" = 1 ]; then
  python3 -I "$HERE/workspace.py" live --root "$ROOT" > "$ROOT/logs/live.pid" 2> "$ROOT/logs/live.err" &
  LIVE=$!
  sleep 1
fi

LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST=menubar COOOL_SELFTEST_DIR="$H/code" COOOL_SELFTEST_SHOTS="$ROOT/shots" \
  COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_BACKGROUND=1 \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

i=0
while [ $i -lt 600 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
if [ -n "$LIVE" ]; then
  kill $LIVE 2>/dev/null || true
  wait $LIVE 2>/dev/null || true
fi
grep -E 'PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"
ok=0
grep -q 'SUMMARY pass=[0-9]* fail=0' "$LOG" && ok=1
if [ -n "${MENUBAR_OUT:-}" ]; then
  mkdir -p "$MENUBAR_OUT"
  cp "$LOG" "$MENUBAR_OUT"/ 2>/dev/null || true
  echo "log copied to $MENUBAR_OUT"
fi
if [ "${MENUBAR_KEEP:-0}" != 1 ]; then
  rm -rf "$ROOT" "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
fi
[ $ok = 1 ]
