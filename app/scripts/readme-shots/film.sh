#!/bin/sh
# Motion footage of the real app for the launch film, on the README's invented workspace. From the repo:
#
#   sh app/scripts/readme-shots/film.sh [scenario]       # film (default), film-measure or film-probe
#
# Same setup as run.sh (read it first): the invented workspace under $FILM_ROOT (default /private/tmp/coool-film-ws,
# wiped and made again each run), the stand-in `claude`, the live sessions, then the app (a renamed copy of
# ${COOOL_BIN:-$CARGO_TARGET_DIR/debug/coool}) with COOOL_SELFTEST=<scenario> (app/src/selftestFilm.ts), off screen
# and never focused. Bursts of window-alone stills land in $FILM_ROOT/shots/film-<name>/; film-assemble.py turns
# each into a 30 fps video and copies the stills into $FILM_OUT (default launch-video/footage).
#
# FILM_SLOW (default 3): the scene plays that many times slower than real time while it records (the page's
# animations and clock, the stand-in CLIs, the live workspace), and the assembler plays it back that much faster, so
# a capture of ~8-25 stills a second (it depends on how busy the Mac is) still makes smooth 30 fps video.
# FILM_DILATE: `animations` (default: CSS / Web Animations) or `all` (also the page's clock; a chat's last reply then fails to show).
# FILM_MAC=1 also films the Mac panel: the sandbox Mac in FILM_VM_DIR (default the app's own,
# ~/Library/Application Support/sh.coool.app/vm) is booted through the app, used (TextEdit), and shut down after; it
# is never installed, deleted or reconfigured (a self-test stubs installs). Only while no other coool runs that Mac.
# FILM_ONLY: a comma list of shots to take (sessions, hero-light, changes, needs, chat-approval, browser, iphone, mac).
# FILM_WORKERS (default 2): screencapture processes taking stills at once.
# Don't edit this file while it runs: the shell reads it as it goes.
#
# Also serves app/scripts/readme-shots/site/ on 127.0.0.1:$FILM_PORT (default 8763) for the Browser panel shot.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ROOT=${FILM_ROOT:-/private/tmp/coool-film-ws}
OUT=${FILM_OUT:-$REPO/launch-video/footage}
PORT=${FILM_PORT:-8763}
SCENARIO=${1:-film}
SLOW=${FILM_SLOW:-3}
FILM_VM_DIR=${FILM_VM_DIR:-$HOME/Library/Application Support/sh.coool.app/vm}
NAME=coool-film

BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.coool-film" ] || { echo "$ROOT exists and isn't ours; remove it or set FILM_ROOT"; exit 1; }
  rm -rf "$ROOT"
fi
python3 -I "$HERE/workspace.py" build --film --root "$ROOT"
touch "$ROOT/.coool-film"
cp "$HERE/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
mkdir -p "$ROOT/app" "$ROOT/shots" "$ROOT/logs"
cp "$BIN" "$ROOT/app/$NAME"
H="$ROOT/home"
case "$H" in /Users/*) echo "refusing a HOME under /Users"; exit 1 ;; esac
echo "$SLOW" > "$H/.film-slow"
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/site" > "$ROOT/logs/site.log" 2>&1 &
SITE=$!
LOG="$ROOT/logs/selftest.log"
# The sandbox Mac only when asked, and only while nothing else runs it (its helper holds the VM folder's lock too).
VMDIR="$ROOT/no-vm"
if [ "${FILM_MAC:-0}" = 1 ]; then
  if pgrep -x coool-vm > /dev/null; then echo "the sandbox Mac is in use (a coool-vm helper runs); not filming it"; else VMDIR=$FILM_VM_DIR; fi
fi
python3 -I "$HERE/workspace.py" live --film --cues "$LOG" --root "$ROOT" > "$ROOT/logs/live.pid" 2> "$ROOT/logs/live.err" &
LIVE=$!
sleep 1

env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST="$SCENARIO" COOOL_SELFTEST_DIR="$H/code" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_SITE="http://127.0.0.1:$PORT/" COOOL_SELFTEST_BACKGROUND=1 COOOL_GLASS_ACTIVE=1 COOOL_FILM_WORKERS="${FILM_WORKERS:-2}" COOOL_FILM_SLOW="$SLOW" COOOL_FILM_DILATE="${FILM_DILATE:-animations}" \
  COOOL_FILM_MAC="${FILM_MAC:-0}" COOOL_VM_DIR="$VMDIR" COOOL_FILM_ONLY="${FILM_ONLY:-}" \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

i=0
while [ $i -lt 1500 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
kill $LIVE $SITE 2>/dev/null || true
wait $LIVE $SITE 2>/dev/null || true
grep -E 'PASS|FAIL|WARN|SUMMARY|FILM' "$LOG" || cat "$LOG"

if [ "$SCENARIO" = film ]; then
  mkdir -p "$OUT"
  python3 -I "$HERE/film-assemble.py" --shots "$ROOT/shots" --log "$LOG" --out "$OUT"
fi
if [ "${FILM_KEEP:-0}" != 1 ]; then
  rm -rf "$ROOT" "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
fi
