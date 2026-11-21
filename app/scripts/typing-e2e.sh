#!/bin/sh
# The message list holds still while the person types (self-test scenario `typing-steady`, app/src/selftestTyping.ts),
# in the real app, on a scratch git repository with the stand-in CLIs of app/scripts/readme-shots (no model, no network,
# no account):
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/typing-e2e.sh
#
# Everything lives under $TYPING_ROOT (default /private/tmp/coool-typing-e2e): a throwaway HOME (so ~/.claude is the
# stand-in's own), the repository at $HOME/code/repo, the log and the screenshots. The window stays off screen
# (COOOL_SELFTEST_BACKGROUND=1). Only this run's processes are stopped.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${TYPING_ROOT:-/private/tmp/coool-typing-e2e}
NAME=coool-typing-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
case "$ROOT" in /private/tmp/coool-typing-*|/tmp/coool-typing-*) ;; *) echo "TYPING_ROOT must be under /tmp/coool-typing-"; exit 1 ;; esac

rm -rf "$ROOT"
H="$ROOT/home"
W="$H/code/repo"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs" "$W"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"

g() { env -i HOME="$H" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 git -C "$W" "$@"; }
g init -q -b main
g config user.name "coool test"
g config user.email "test@coool.invalid"
g config commit.gpgsign false
i=1; while [ $i -le 40 ]; do echo "line $i"; i=$((i + 1)); done > "$W/a.txt"
g add -A
g commit -q -m "start"

rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST="${TYPING_SCENARIOS:-typing-steady}" COOOL_SELFTEST_DIR="$W" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_BACKGROUND=1 \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

i=0
while [ $i -lt 240 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
grep -E 'typing-steady|PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"
# The stand-in CLIs end shortly after their pipes close.
i=0
while [ $i -lt 10 ] && ps -axo command= | grep -F "$ROOT" | grep -qv grep; do sleep 1; i=$((i + 1)); done
left=$(ps -axo pid=,command= | grep -F "$ROOT" | grep -v grep || true)
[ -z "$left" ] && echo "cleanup: nothing left running" || { echo "still running:"; echo "$left"; }
echo "shots: $ROOT/shots"
[ "${TYPING_KEEP:-0}" = 1 ] || rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
grep -q 'fail=0' "$LOG"
