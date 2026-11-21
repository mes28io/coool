#!/bin/sh
# The existing chat self-tests with every chat started in a test chat host (APP_SPEC "Chats that outlive the app"):
# the same behaviour as chats inside the app.
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/keepalive-chat-selftests.sh [scenarios]
#
# Default scenarios: stream,approval,interrupt,model,slash,question,steer,codex (real model calls, cheapest models).
# Everything under /private/tmp/coool-host-selftests; the window out of sight; only this run's processes are stopped.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
SC=${1:-stream,approval,interrupt,model,slash,question,steer,codex}
ROOT=/private/tmp/coool-host-selftests
NAME=coool-ka-selftests
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
rm -rf "$ROOT"
mkdir -p "$ROOT/work" "$ROOT/host" "$ROOT/app"
cp "$BIN" "$ROOT/app/$NAME"
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
LOG="$ROOT/selftest.log"
# KA_NOHOST=1: the same run with chats inside the app (the baseline to compare with).
HOSTENV="COOOL_CHAT_HOST_DIR=$ROOT/host"
[ -n "${KA_NOHOST:-}" ] && HOSTENV="COOOL_KA_NOHOST=1"
env COOOL_SELFTEST="$SC" COOOL_SELFTEST_DIR="$ROOT/work" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_OFFSCREEN=1 "$HOSTENV" \
  "$ROOT/app/$NAME" > "$ROOT/app.out" 2>&1 &
APP=$!
i=0
while [ $i -lt 1800 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  kill -0 $APP 2>/dev/null || { echo "the app exited early"; break; }
  sleep 1
  i=$((i + 1))
done
# Every chat must have been hosted: the host's log names the socket it served.
grep -h "serving" "$ROOT/host/host.log" || echo "no chat host started"
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
for f in "$ROOT"/host/host-*.json; do
  [ -f "$f" ] || continue
  p=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f")
  ps -o command= -p "$p" 2>/dev/null | grep -q -- "--coool-chat-host $ROOT/host" && kill "$p" 2>/dev/null || true
done
sleep 5
grep -E ' (PASS|FAIL|SUMMARY)' "$LOG"
# The CLIs and their MCP proxies end shortly after their pipes close.
i=0
while [ $i -lt 20 ] && ps -axo command= | grep -F "$ROOT" | grep -qv grep; do sleep 1; i=$((i + 1)); done
left=$(ps -axo pid=,command= | grep -F "$ROOT" | grep -v grep || true)
[ -z "$left" ] && echo "cleanup: nothing left running" || { echo "still running:"; echo "$left"; }
