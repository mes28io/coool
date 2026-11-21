#!/bin/sh
# The 0.4.0 -> 0.4.1 update as the person had it, in the real app with the stand-in CLIs (no model, no account):
# launch 1 runs a chat inside coool (the chat host off, as 0.4.0 had no host) and quits, so the chat ends with the app;
# launch 2 has the host on with no host folder yet, types in the ended chat's message box, starts a new chat, and
# sends to both running chats. The host takes KA_STALL_MS (default 15000) over each start, as a slow or stuck host
# would: meanwhile the window's calls, the sessions and a send to the running chat must answer within 3 s, and every
# step must finish (scenarios `ka-ended-seed`/`ka-ended-after` in app/src/selftestKeepalive.ts). KA_STALL_MS=0: no stall.
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/keepalive-ended-e2e.sh
#
# Everything lives under $KA_ROOT (default /private/tmp/coool-host-ka-ended): a throwaway HOME, the test folder, the
# chat host's folder (created by the app), logs and screenshots. Only processes this script started are signalled.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${KA_ROOT:-/private/tmp/coool-host-ka-ended}
case "$ROOT" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "KA_ROOT must be under /tmp/coool-host-"; exit 1 ;; esac
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
NAME=coool-ka-ended-e2e
rm -rf "$ROOT"
# KA_HOME: a bigger throwaway HOME made beforehand (under /tmp/coool-host-…), used as it is.
H=${KA_HOME:-$ROOT/home}
case "$H" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "KA_HOME must be under /tmp/coool-host-"; exit 1 ;; esac
mkdir -p "$H" "$ROOT/work/ka-ended" "$ROOT/work/ka-ended-new" "$ROOT/bin" "$ROOT/app" "$ROOT/logs" "$ROOT/shots"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
HOSTDIR="$ROOT/host"
STARTED=""
STALL=""

launch() { # <scenario> [host dir]
  LOG="$ROOT/logs/$1.log"
  env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
    PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    COOOL_SELFTEST="$1" COOOL_SELFTEST_DIR="$ROOT/work" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_OFFSCREEN=1 \
    ${2:+COOOL_CHAT_HOST_DIR="$2"} ${STALL:+COOOL_TEST_HOST_STALL_MS="$STALL"} "$ROOT/app/$NAME" >> "$ROOT/logs/app.out" 2>&1 &
  APP=$!
  STARTED="$STARTED $APP"
  echo "launched $1 as $APP"
}
until_line() { # <pattern> <secs>
  i=0
  while [ $i -lt "$2" ]; do
    grep -q -- "$1" "$LOG" 2>/dev/null && return 0
    kill -0 "$APP" 2>/dev/null || { grep -q -- "$1" "$LOG" 2>/dev/null && return 0; return 1; }
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Launch 1: no host (as 0.4.0); the chat ends when the app quits.
launch ka-ended-seed
until_line "KA-QUIT ka-ended" 90 || echo "seed: no quit line"
i=0; while [ $i -lt 30 ] && kill -0 "$APP" 2>/dev/null; do sleep 1; i=$((i + 1)); done
kill "$APP" 2>/dev/null || true
[ -d "$HOSTDIR" ] && echo "WARN the seed launch made a host folder"

# Launch 2: the host on, its folder not there yet.
# The update's first launch: the session cache of the old version doesn't count (its format changed) and History has
# no index yet.
rm -rf "$H/Library/Caches/coool" "$H/Library/Application Support/coool/history"
STALL=${KA_STALL_MS:-15000}
[ "$STALL" = 0 ] && STALL=""
launch ka-ended-after "$HOSTDIR"
if until_line " END$" 900; then echo "launch 2 ended"; else echo "launch 2 timed out or exited early"; fi
kill "$APP" 2>/dev/null || true
for p in $STARTED; do kill "$p" 2>/dev/null || true; done
# The host this run started (its folder is ours): by pid, from its own file.
for f in "$HOSTDIR"/*.json; do
  [ -f "$f" ] || continue
  hp=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$f" | head -1)
  if [ -n "$hp" ] && ps -o command= -p "$hp" 2>/dev/null | grep -q -- "--coool-chat-host $HOSTDIR"; then kill "$hp" 2>/dev/null || true; fi
done
# The stand-in CLIs the host ran (their path is this run's own).
for p in $(ps -axo pid=,command= | grep -F "$ROOT/bin/" | grep -v grep | awk '{print $1}'); do kill "$p" 2>/dev/null || true; done
echo "--- results"
grep -hE 'PASS|FAIL|SUMMARY' "$ROOT/logs/ka-ended-seed.log" "$ROOT/logs/ka-ended-after.log" 2>/dev/null || true
echo "--- app stderr (coool lines)"
grep 'coool:' "$ROOT/logs/app.out" | tail -20 || true
[ "${KA_KEEP:-0}" = 1 ] || rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
grep -q 'PASS ka-ended: a chat inside' "$ROOT/logs/ka-ended-seed.log" && grep -q 'fail=0' "$ROOT/logs/ka-ended-after.log"
