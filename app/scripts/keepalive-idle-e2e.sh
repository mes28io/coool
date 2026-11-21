#!/bin/sh
# Idle hosted chats across an update's restart, in the real app with the stand-in CLIs (no model, no account): launch 1
# starts three chats in the chat host and lets their turns end (one reply streamed in more pieces than a chat keeps for
# replay; in another an Agent call is cut off and the transcript is then written as `claude -p` writes it, the person's
# 0.4.3 case), starts a fourth whose step runs on (75 s), and quits; launch 2 (the update's relaunch) takes them in from
# the host. Every chat whose CLI is idle must show idle (the chat, its row, the title bar's "N working"), and again after
# a message's turn ends; the one mid-turn shows working until its turn ends (scenarios `ka-idle-seed`/`ka-idle-after` in
# app/src/selftestKeepalive.ts). With KA_SEED_BIN and COOOL_BIN both a 0.4.1-0.4.3 build, launch 2 fails as the person's
# app did: the chat with the cut-off agent stays "working".
#
#   COOOL_BIN=<debug build with the current frontend> [KA_SEED_BIN=<build of an older version>] sh app/scripts/keepalive-idle-e2e.sh
#
# KA_SEED_BIN: launch 1 runs that build (an older coool, e.g. v0.4.1 with these two scenarios added to its frontend), so
# the host is of the older version and launch 2 is attached to a draining host: the person's state after an update.
# Everything lives under $KA_ROOT (default /private/tmp/coool-host-ka-idle): a throwaway HOME, the test folder, the
# chat host's folder, logs and screenshots. Only processes this script started are signalled, by pid.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${KA_ROOT:-/private/tmp/coool-host-ka-idle}
case "$ROOT" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "KA_ROOT must be under /tmp/coool-host-"; exit 1 ;; esac
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
SEED=${KA_SEED_BIN:-$BIN}
[ -x "$BIN" ] && [ -x "$SEED" ] || { echo "no binary at $BIN or $SEED (set COOOL_BIN / KA_SEED_BIN)"; exit 1; }
NAME=coool-ka-idle-e2e
rm -rf "$ROOT"
H=$ROOT/home
mkdir -p "$H" "$ROOT/work" "$ROOT/bin" "$ROOT/app" "$ROOT/logs" "$ROOT/shots"
for f in ka-idle-a ka-idle-b ka-idle-c ka-idle-busy; do mkdir -p "$ROOT/work/$f"; done
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$SEED" "$ROOT/app/seed-$NAME"
cp "$BIN" "$ROOT/app/after-$NAME"
# WebKit keeps each executable name's data under the real home: start clean, and remove it at the end.
webkit_clean() { for n in "seed-$NAME" "after-$NAME"; do rm -rf "$HOME/Library/WebKit/$n" "$HOME/Library/Caches/$n"; done; }
webkit_clean
HOSTDIR="$ROOT/host"
STARTED=""
# KA_REAL=1: the real Claude Code on Haiku in the person's own HOME (its login), five short turns; the folders' own
# settings allow only the busy chat's `sleep` and `echo`.
REAL=${KA_REAL:-0}
if [ "$REAL" = 1 ]; then
  printf '{"ka-idle-real": true}\n' > "$ROOT/work/keepalive-notes.json"
  for f in ka-idle-a ka-idle-b ka-idle-c ka-idle-busy; do
    mkdir -p "$ROOT/work/$f/.claude"
    printf '{"permissions":{"allow":["Bash(sleep:*)","Bash(echo:*)","Bash(sleep *)","Bash(echo *)"]}}\n' > "$ROOT/work/$f/.claude/settings.local.json"
  done
fi

launch() { # <scenario> <executable>
  LOG="$ROOT/logs/$1.log"
  if [ "$REAL" = 1 ]; then
    env COOOL_SELFTEST="$1" COOOL_SELFTEST_DIR="$ROOT/work" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_OFFSCREEN=1 \
      COOOL_CHAT_HOST_DIR="$HOSTDIR" "$2" >> "$ROOT/logs/app.out" 2>&1 &
    APP=$!
    STARTED="$STARTED $APP"
    echo "launched $1 as $APP (real CLI)"
    return
  fi
  env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
    PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    COOOL_SELFTEST="$1" COOOL_SELFTEST_DIR="$ROOT/work" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_OFFSCREEN=1 \
    COOOL_CHAT_HOST_DIR="$HOSTDIR" "$2" >> "$ROOT/logs/app.out" 2>&1 &
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

launch ka-idle-seed "$ROOT/app/seed-$NAME"
until_line "KA-QUIT ka-idle" 240 || echo "seed: no quit line"
i=0; while [ $i -lt 30 ] && kill -0 "$APP" 2>/dev/null; do sleep 1; i=$((i + 1)); done
kill "$APP" 2>/dev/null || true
grep -h "serving" "$HOSTDIR/host.log" 2>/dev/null || echo "WARN no chat host started"
sleep 3
launch ka-idle-after "$ROOT/app/after-$NAME"
if until_line " END$" 600; then echo "launch 2 ended"; else echo "launch 2 timed out or exited early"; fi
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
grep -hE 'PASS|FAIL|SUMMARY' "$ROOT/logs/ka-idle-seed.log" "$ROOT/logs/ka-idle-after.log" 2>/dev/null || true
echo "--- app stderr (coool lines)"
grep 'coool' "$ROOT/logs/app.out" | grep -v '^\s*$' | tail -20 || true
[ "${KA_KEEP:-0}" = 1 ] || webkit_clean
sleep 2
left=$(ps -axo pid=,command= | grep -F "$ROOT" | grep -v grep || true)
[ -z "$left" ] && echo "cleanup: nothing left running" || { echo "still running:"; echo "$left"; }
! grep -q 'FAIL' "$ROOT/logs/ka-idle-seed.log" && grep -q 'PASS ka-idle-busy: its turn ends' "$ROOT/logs/ka-idle-after.log" && grep -q 'fail=0' "$ROOT/logs/ka-idle-after.log"
