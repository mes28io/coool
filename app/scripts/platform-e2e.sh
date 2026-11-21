#!/bin/sh
# Claude Platform (APP_SPEC "Claude Platform"; self-test scenario `platform`, app/src/selftestPlatform.ts): chats billed
# to an API key instead of the subscription, in the real app with the stand-in CLIs of app/scripts/readme-shots (no
# model, no network, no account). Two launches: the chats run inside coool (no chat host), then in a chat host of the
# run's own (COOOL_CHAT_HOST_DIR), so the key must reach the CLI through the host.
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/platform-e2e.sh
#
# The key is an invented one, given to the debug build as COOOL_PLATFORM_TEST_KEY (it stands in for the Keychain: no
# Keychain item is read or written), and the app runs with an invented CLAUDE_CODE_OAUTH_TOKEN that an API-key chat
# must not inherit. The stand-in reports only whether it has a key, its last four characters, and which other login
# variables it sees. Afterwards this script checks that no file of the run holds the key (logs, the host's folder,
# coool's store), only the stand-in's own transcript of what it was told.
#
# Everything lives under $PLATFORM_ROOT (default /private/tmp/coool-host-platform-e2e): a throwaway HOME, the test
# folder, the host's folder, logs and screenshots. The window stays off screen, no menu bar item. Only this run's
# processes are stopped.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${PLATFORM_ROOT:-/private/tmp/coool-host-platform-e2e}
case "$ROOT" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "PLATFORM_ROOT must be under /tmp/coool-host-"; exit 1 ;; esac
NAME=coool-platform-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
TEST_KEY=sk-ant-api03-TESTTESTTEST  # the same invented key the self-test pastes into Settings

rm -rf "$ROOT"
H="$ROOT/home"
W="$H/code/billing"
HOSTDIR="$ROOT/host"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs" "$W"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

run() { # <tag> [host dir]
  LOG="$ROOT/logs/$1.log"
  mkdir -p "$ROOT/shots/$1"
  env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
    PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    COOOL_PLATFORM_TEST_KEY="$TEST_KEY" CLAUDE_CODE_OAUTH_TOKEN=coool-e2e-invented-oauth COOOL_MENUBAR_HIDDEN=1 \
    COOOL_SELFTEST=platform COOOL_SELFTEST_DIR="$W" COOOL_SELFTEST_SHOTS="$ROOT/shots/$1" COOOL_SELFTEST_LOG="$LOG" \
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
i=0
while [ $i -lt 10 ] && ps -axo command= | grep -F "$ROOT/" | grep -qv grep; do sleep 1; i=$((i + 1)); done
for p in $(ps -axo pid=,command= | grep -F "$ROOT/" | grep -v grep | awk '{print $1}'); do kill "$p" 2>/dev/null || true; done
left=$(ps -axo pid=,command= | grep -F "$ROOT/" | grep -v grep || true)
[ -z "$left" ] && echo "cleanup: nothing left running" || { echo "still running:"; echo "$left"; }

# The key must not be written anywhere by coool: not in its logs, the host's folder, its store or caches. (The
# stand-in's own transcripts under ~/.claude hold only what it said: the last four.)
leak=$(grep -rlF -- "$TEST_KEY" "$ROOT" 2>/dev/null | grep -v "^$ROOT/app/" || true)
if [ -n "$leak" ]; then echo "LEAK: the key is in:"; echo "$leak"; else echo "no file of the run holds the key"; fi
echo "shots: $ROOT/shots"
[ "${PLATFORM_KEEP:-0}" = 1 ] || rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
[ -z "$leak" ] && grep -q 'fail=0' "$ROOT/logs/inside.log" && grep -q 'fail=0' "$ROOT/logs/hosted.log"
