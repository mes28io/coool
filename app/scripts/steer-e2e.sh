#!/bin/sh
# Queued and Now notes (CHAT_SPEC "Steering"; self-test scenario `steer-queue`, app/src/selftestSteer.ts), in the real
# app with the stand-in Claude CLI of app/scripts/readme-shots in queue mode (no model, no network, no account): it
# runs user lines through a queue as Claude Code 2.1.330 does, with background tasks whose notifications get turns of
# their own. Two launches: the chat runs inside coool (no chat host), then in a chat host of the run's own
# (COOOL_CHAT_HOST_DIR).
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/steer-e2e.sh
#
# Everything lives under $STEER_ROOT (default /private/tmp/coool-host-steer-e2e): a throwaway HOME (so ~/.claude is
# the stand-in's own), the test folder, the host's folder, logs and screenshots. The window stays off screen
# (COOOL_SELFTEST_BACKGROUND=1), no menu bar item. Only this run's processes are stopped.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${STEER_ROOT:-/private/tmp/coool-host-steer-e2e}
case "$ROOT" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "STEER_ROOT must be under /tmp/coool-host-"; exit 1 ;; esac
NAME=coool-steer-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }

rm -rf "$ROOT"
H="$ROOT/home"
W="$H/code/notes"
HOSTDIR="$ROOT/host"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs" "$W"
echo '{}' > "$W/.mcp.json"
echo '# notes' > "$W/README.md"
# The stand-in's queue mode (lifecycle frames, mid-turn notes, background tasks, interrupt, cancel_async_message).
touch "$H/.standin-queue"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

run() { # <tag> [host dir]
  LOG="$ROOT/logs/$1.log"
  mkdir -p "$ROOT/shots/$1"
  env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
    PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin" COOOL_MENUBAR_HIDDEN=1 \
    COOOL_SELFTEST=steer-queue COOOL_SELFTEST_DIR="$W" COOOL_SELFTEST_SHOTS="$ROOT/shots/$1" COOOL_SELFTEST_LOG="$LOG" \
    COOOL_SELFTEST_BACKGROUND=1 ${2:+COOOL_CHAT_HOST_DIR="$2"} \
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
}

run inside
run hosted "$HOSTDIR"

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
left=$(ps -axo pid=,command= | grep -F "$ROOT/" | grep -v grep || true)
[ -z "$left" ] && echo "cleanup: nothing left running" || { echo "still running:"; echo "$left"; }
[ -f "$H/standin.err" ] && { echo "stand-in errors:"; cat "$H/standin.err"; }
echo "shots: $ROOT/shots"
[ "${STEER_KEEP:-0}" = 1 ] || rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
grep -q 'fail=0' "$ROOT/logs/inside.log" && grep -q 'fail=0' "$ROOT/logs/hosted.log"
