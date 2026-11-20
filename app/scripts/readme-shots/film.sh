#!/bin/sh
# Motion footage of the real app for the launch film, on the README's invented workspace. From the repo:
#
#   sh app/scripts/readme-shots/film.sh [scenario]       # film (default) or film-measure
#
# Same setup as run.sh (read it first): the invented workspace under $FILM_ROOT (default /private/tmp/coool-film-ws,
# wiped and made again each run), the stand-in `claude`, the live sessions, then the app (a renamed copy of
# ${COOOL_BIN:-$CARGO_TARGET_DIR/debug/coool}) with COOOL_SELFTEST=<scenario> (app/src/selftestFilm.ts), off screen
# and never focused. Bursts of window-alone stills land in $FILM_ROOT/shots/film-<name>/; film-assemble.py turns
# each into a 30 fps video and copies the stills into $FILM_OUT (default launch-video/footage).
#
# Also serves app/scripts/readme-shots/site/ on 127.0.0.1:$FILM_PORT (default 8763) for the Browser panel shot.
# FILM_SLOW (default 3): how much slower than real time the scripted world runs while bursts record (the page's
# animations, the stand-in's pace and the live sessions); the assembler plays it back FILM_SLOW times faster.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ROOT=${FILM_ROOT:-/private/tmp/coool-film-ws}
OUT=${FILM_OUT:-$REPO/launch-video/footage}
PORT=${FILM_PORT:-8763}
SLOW=${FILM_SLOW:-3}
SCENARIO=${1:-film}
NAME=coool-film

BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.coool-film" ] || { echo "$ROOT exists and isn't ours; remove it or set FILM_ROOT"; exit 1; }
  rm -rf "$ROOT"
fi
python3 -I "$HERE/workspace.py" build --root "$ROOT"
touch "$ROOT/.coool-film"
cp "$HERE/standin-claude.py" "$ROOT/bin/claude"
printf '#!/bin/sh\nexit 1\n' > "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
mkdir -p "$ROOT/app" "$ROOT/shots" "$ROOT/logs"
cp "$BIN" "$ROOT/app/$NAME"
H="$ROOT/home"
case "$H" in /Users/*) echo "refusing a HOME under /Users"; exit 1 ;; esac
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/site" > "$ROOT/logs/site.log" 2>&1 &
SITE=$!
FILM_SLOW=$SLOW python3 -I "$HERE/workspace.py" live --root "$ROOT" > "$ROOT/logs/live.pid" 2> "$ROOT/logs/live.err" &
LIVE=$!
sleep 1

LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST="$SCENARIO" COOOL_SELFTEST_DIR="$H/code" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_SITE="http://127.0.0.1:$PORT/" COOOL_SELFTEST_BACKGROUND=1 COOOL_GLASS_ACTIVE=1 FILM_SLOW="$SLOW" \
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
  python3 -I "$HERE/film-assemble.py" --shots "$ROOT/shots" --out "$OUT" --slow "$SLOW"
fi
if [ "${FILM_KEEP:-0}" != 1 ]; then
  rm -rf "$ROOT" "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
fi
