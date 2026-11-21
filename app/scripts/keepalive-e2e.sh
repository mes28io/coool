#!/bin/sh
# Chats that outlive the app, end to end in the real app (APP_SPEC "Chats that outlive the app"; the scenarios are in
# app/src/selftestKeepalive.ts). Real model calls on the cheapest models (Claude Haiku, Codex's luna), few turns.
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/keepalive-e2e.sh chats
#   KA_APP_A=<bundle at the current version> KA_APP_B=<bundle at a newer one> sh app/scripts/keepalive-e2e.sh update
#
# `chats`: a Haiku chat survives a normal quit, a second one a `kill -9` of the app, a permission request asked while
# coool was closed is answered after the relaunch, a Codex chat survives a quit, and with the setting off a chat ends
# at the quit as before. `update`: two test bundles and a loopback release server (signed with a throwaway key);
# Settings > About's "Update and restart" with a Ladder lead mid-turn and a helper running; the relaunch into the new
# bundle finds both still running.
#
# Everything lives under $KA_ROOT (default /private/tmp/coool-host-ka-<mode>): the test folder, the chat host's own
# folder (COOOL_CHAT_HOST_DIR, so this host and the person's never meet), logs and screenshots. The window stays out of
# sight (COOOL_SELFTEST_OFFSCREEN=1); no menu bar item. Only processes this script started are signalled, by pid.
set -eu
MODE=${1:-chats}
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${KA_ROOT:-/private/tmp/coool-host-ka-$MODE}
case "$ROOT" in /private/tmp/coool-host-*|/tmp/coool-host-*) ;; *) echo "KA_ROOT must be under /tmp/coool-host-"; exit 1 ;; esac
PORT=${KA_PORT:-18733}
NAME=coool-ka-e2e
rm -rf "$ROOT"
W="$ROOT/work"
mkdir -p "$W" "$ROOT/host" "$ROOT/logs" "$ROOT/shots" "$ROOT/app"
RES="$ROOT/logs/result.txt"
: > "$RES"
ok() { echo "PASS $*" | tee -a "$RES"; }
bad() { echo "FAIL $*" | tee -a "$RES"; }

# The case folders: their own Claude Code settings allow only the steps' `sleep` and `echo` (so a turn needs nobody
# while coool is closed); `touch` (ka-perm) is asked for.
for f in ka-claude ka-kill ka-perm ka-codex ka-off ka-update; do
  mkdir -p "$W/$f/.claude"
  printf '{"permissions":{"allow":["Bash(sleep:*)","Bash(echo:*)","Bash(sleep *)","Bash(echo *)"]}}\n' > "$W/$f/.claude/settings.local.json"
done

STARTED=""
launch() { # <scenario> <executable>
  LOG="$ROOT/logs/$1.log"
  COOOL_SELFTEST="$1" COOOL_SELFTEST_DIR="$W" COOOL_SELFTEST_LOG="$LOG" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_OFFSCREEN=1 \
    COOOL_CHAT_HOST_DIR="$ROOT/host" "$2" >> "$ROOT/logs/app.out" 2>&1 &
  APP=$!
  STARTED="$STARTED $APP"
  echo "launched $1 as $APP"
}
waitline() { # <pattern> <secs>
  i=0
  while [ $i -lt "$2" ]; do
    grep -q -- "$1" "$LOG" 2>/dev/null && return 0
    kill -0 "$APP" 2>/dev/null || { grep -q -- "$1" "$LOG" 2>/dev/null && return 0; echo "the app exited before \"$1\""; return 1; }
    sleep 1
    i=$((i + 1))
  done
  echo "timed out waiting for \"$1\" in $LOG"
  return 1
}
waitexit() { # <secs>
  i=0
  while [ $i -lt "$1" ] && kill -0 "$APP" 2>/dev/null; do sleep 1; i=$((i + 1)); done
  ! kill -0 "$APP" 2>/dev/null
}
field() { # <case> <key>: from the KA-PIDS line of the current log
  grep "KA-PIDS $1 " "$LOG" | tail -1 | tr ' ' '\n' | sed -n "s/^$2=//p" | tr ',' ' '
}
alive() { [ -n "$1" ] && ps -p "$1" > /dev/null 2>&1; }
report() { grep -E '^.{0,40}(PASS|FAIL)' "$LOG" | sed 's/^/  /' || true; grep -q ' FAIL ' "$LOG" && bad "scenario failures in $(basename "$LOG")" || true; }
HOSTS=""
CLIS=""
quit_case() { # <case>: the app quits by itself; its CLI must still run
  if waitline "KA-QUIT $1" 400 && waitexit 30; then ok "$1: the app quit"; else bad "$1: the app didn't quit"; fi
  cli=$(field "$1" cli)
  CLIS="$CLIS $cli"
  HOSTS="$HOSTS $(field "$1" hosts)"
  if alive "$cli"; then ok "$1: CLI $cli still running after the quit ($(ps -o command= -p "$cli" | cut -c1-60))"; else bad "$1: CLI '$cli' gone after the quit"; fi
  report
}

if [ "$MODE" = chats ]; then
  BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
  [ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
  cp "$BIN" "$ROOT/app/$NAME"
  EXE="$ROOT/app/$NAME"
  rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

  launch ka-claude-start "$EXE"; quit_case ka-claude; sleep 10
  launch ka-claude-after "$EXE"
  if waitline KA-READY-KILL 600; then
    kcli=$(field ka-kill cli)
    CLIS="$CLIS $kcli"
    HOSTS="$HOSTS $(field ka-kill hosts)"
    kill -9 "$APP"
    waitexit 10 && ok "ka-kill: the app was killed (kill -9 $APP)" || bad "ka-kill: the app survived kill -9"
    if alive "$kcli"; then ok "ka-kill: CLI $kcli still running after the kill"; else bad "ka-kill: CLI '$kcli' gone after the kill"; fi
  else
    bad "ka-claude-after didn't reach the kill"
  fi
  report; sleep 8
  launch ka-kill-after "$EXE"; quit_case ka-perm; sleep 14
  launch ka-perm-after "$EXE"; quit_case ka-codex; sleep 10
  launch ka-codex-after "$EXE"
  if waitline "KA-QUIT ka-off" 400 && waitexit 30; then ok "ka-off: the app quit"; else bad "ka-off: the app didn't quit"; fi
  ocli=$(field ka-off cli)
  sleep 5
  if alive "$ocli"; then bad "ka-off: CLI $ocli still running with the setting off"; else ok "ka-off: with the setting off the chat's CLI $ocli ended at the quit (as before)"; fi
  report
  [ -f "$W/ka-perm/ka-perm.txt" ] && ok "ka-perm: the file the allowed request made exists" || bad "ka-perm: no ka-perm.txt"
fi

if [ "$MODE" = update ]; then
  A=${KA_APP_A:?set KA_APP_A to the bundle at the current version}
  B=${KA_APP_B:?set KA_APP_B to the bundle at the newer version}
  VB=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$B/Contents/Info.plist")
  VA=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$A/Contents/Info.plist")
  echo "A=$VA B=$VB"
  # Bundle A where it may replace itself; B as a signed release on a loopback server.
  ditto "$A" "$ROOT/app/coool.app"
  REL="$ROOT/srv/mes28io/coool/releases/download/v$VB"
  mkdir -p "$REL" "$ROOT/srv/repos/mes28io/coool/releases" "$ROOT/keys"
  (cd "$(dirname "$B")" && COPYFILE_DISABLE=1 tar -czf "$REL/coool-macos-arm64.tar.gz" "$(basename "$B")")
  (cd "$REL" && shasum -a 256 coool-macos-arm64.tar.gz > coool-macos-arm64.tar.gz.sha256)
  SIGN=${KA_SIGN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/examples/sign_release}
  "$SIGN" keygen > "$ROOT/keys/pair"
  PUB=$(sed -n 's/^public //p' "$ROOT/keys/pair")
  printf 'pub const PINNED: &[&str] = &["%s"];\n' "$PUB" > "$ROOT/keys/keys.rs"
  sed -n 's/^secret //p' "$ROOT/keys/pair" | "$SIGN" sign "$REL/coool-macos-arm64.tar.gz" "$ROOT/keys/keys.rs"
  rm -f "$ROOT/keys/pair"
  U="http://127.0.0.1:$PORT/mes28io/coool/releases/download/v$VB"
  printf '{"tag_name":"v%s","draft":false,"prerelease":false,"assets":[{"name":"coool-macos-arm64.tar.gz","browser_download_url":"%s/coool-macos-arm64.tar.gz"},{"name":"coool-macos-arm64.tar.gz.sha256","browser_download_url":"%s/coool-macos-arm64.tar.gz.sha256"},{"name":"coool-macos-arm64.tar.gz.minisig","browser_download_url":"%s/coool-macos-arm64.tar.gz.minisig"}]}\n' "$VB" "$U" "$U" "$U" > "$ROOT/srv/repos/mes28io/coool/releases/latest"
  python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/srv" > "$ROOT/logs/server.out" 2>&1 &
  SRV=$!
  sleep 1
  printf '{"ka-update-to": "%s"}\n' "$VB" > "$W/keepalive-notes.json"
  export COOOL_UPDATE_BASE="http://127.0.0.1:$PORT" COOOL_UPDATE_TEST_PUBKEY="$PUB"
  launch ka-update-start "$ROOT/app/coool.app/Contents/MacOS/coool"
  if waitline "KA-QUIT ka-update" 900 && waitexit 60; then ok "ka-update: the app restarted for the update (exited)"; else bad "ka-update: the app didn't exit for the update"; fi
  lcli=$(field ka-update cli); hcli=$(field ka-update helper)
  CLIS="$CLIS $lcli $hcli"
  HOSTS="$HOSTS $(field ka-update hosts)"
  grep -E 'KA-SCREEN|KA-CONFIRM|UPDATE exiting' "$LOG" | sed 's/^/  /' || true
  report
  NOW=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/app/coool.app/Contents/Info.plist")
  [ "$NOW" = "$VB" ] && ok "ka-update: the bundle is now $NOW" || bad "ka-update: the bundle is $NOW, not $VB"
  if alive "$lcli" && alive "$hcli"; then ok "ka-update: lead CLI $lcli and helper CLI $hcli still running across the restart"; else bad "ka-update: lead '$lcli' or helper '$hcli' gone"; fi
  # The relaunch the updater does with `open` (a self-test doesn't): the new bundle, by its executable.
  launch ka-update-after "$ROOT/app/coool.app/Contents/MacOS/coool"
  waitline ' END$' 900 || true
  report
  kill "$APP" 2>/dev/null || true
  waitexit 10 || true
  kill "$SRV" 2>/dev/null || true
fi

# Stop what this run started: the test apps (by pid) and the test chat hosts (their CLIs end with them).
for p in $STARTED; do kill "$p" 2>/dev/null || true; done
sleep 1
for p in $HOSTS; do
  if [ -n "$p" ] && ps -o command= -p "$p" 2>/dev/null | grep -q -- "--coool-chat-host $ROOT/host"; then kill "$p" 2>/dev/null || true; fi
done
sleep 3
left=$(ps -axo pid=,command= | grep -F "$ROOT" | grep -v grep || true)
for p in $CLIS; do alive "$p" && left="$left
CLI $p: $(ps -o command= -p "$p" | cut -c1-80)"; done
[ -z "$left" ] && ok "cleanup: nothing of this run is left running" || { bad "cleanup: still running:"; echo "$left"; }
echo "---"; cat "$RES"
grep -q FAIL "$RES" && exit 1 || exit 0
