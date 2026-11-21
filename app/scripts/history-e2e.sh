#!/bin/sh
# History end to end in the real app (self-test scenario `history`, app/src/selftestHistory.ts): a throwaway HOME with a
# few thousand invented sessions of both CLIs over two years (app/scripts/history/make-home.py), the stand-in CLIs of
# app/scripts/readme-shots on PATH (no model, no network, no account):
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/history-e2e.sh
#
# Everything lives under $HISTORY_ROOT (default /private/tmp/coool-history-e2e): HOME, the projects (the self-test's
# folder, so only they are listed), the log and the screenshots. The window stays off screen (COOOL_SELFTEST_BACKGROUND=1).
# HISTORY_SESSIONS: how many sessions to invent (default 3000).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${HISTORY_ROOT:-/private/tmp/coool-history-e2e}
NAME=coool-history-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
case "$ROOT" in /private/tmp/coool-history-*|/tmp/coool-history-*) ;; *) echo "HISTORY_ROOT must be under /tmp/coool-history-"; exit 1 ;; esac

rm -rf "$ROOT"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs"
python3 -I "$HERE/history/make-home.py" --out "$ROOT" --sessions "${HISTORY_SESSIONS:-3000}"
H="$ROOT/home"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"

rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST="${HISTORY_SCENARIOS:-history}" COOOL_SELFTEST_DIR="$ROOT/proj" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_BACKGROUND=1 \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

i=0
while [ $i -lt 420 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
grep -E 'PASS|FAIL|WARN|PERF|SUMMARY' "$LOG" || cat "$LOG"

echo "--- the CLIs' folders, afterwards"
# Read only: History never writes there. The one transcript that changed is the session continued with the stand-in.
changed=$(find "$H/.claude/projects" "$H/.codex" -newer "$ROOT/app/$NAME" -type f | sed "s|$H/||")
echo "files written under ~/.claude and ~/.codex during the run: ${changed:-none}"
ls -la "$ROOT/proj/.coool-history" 2>/dev/null || true
echo "shots: $ROOT/shots"
ls "$ROOT/shots"
[ "${HISTORY_KEEP:-0}" = 1 ] || rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
grep -q 'fail=0' "$LOG"
