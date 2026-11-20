#!/bin/sh
# The README screenshots (docs/media/*.png), from the real app on an invented workspace. One command, from the repo:
#
#   sh app/scripts/readme-shots/run.sh
#
# It builds the self-test binary first when READMESHOTS_BUILD=1 (pnpm -C app build, then cargo build -p coool-app
# --features tauri/custom-protocol into $CARGO_TARGET_DIR); otherwise it runs COOOL_BIN, default
# ${CARGO_TARGET_DIR:-target}/debug/coool, which must be a debug build of the current frontend.
#
# What it does:
#  1. workspace.py build: a throwaway HOME under $READMESHOTS_ROOT (default /private/tmp/coool-readme-shots, wiped
#     and made again each run) with six invented projects as real git repositories, Claude Code transcripts and Codex
#     rollouts for invented sessions, and a .zshrc that puts a stand-in `claude` (standin-claude.py: scripted, no
#     model, no network) and a do-nothing `codex` first on PATH.
#  2. workspace.py live: some sessions look live (working, waiting for you, idle) through the CLI's own registry.
#  3. The app (a renamed copy of the binary) with that HOME and COOOL_SELFTEST=readme-shots (app/src/selftestReadme.ts):
#     the window stays off screen and never takes focus (COOOL_SELFTEST_BACKGROUND=1), and each shot is the window
#     alone (screencapture -l, the self-test's own capture), so nothing covers the person's work.
#  4. The shots are copied to docs/media: mission-dark, mission-light, approval-dark, needs-dark, agents-dark.
#
# Nothing reads or writes the real ~/.claude or ~/.codex: the app, the stand-in CLI and git all run with the
# throwaway HOME and a minimal environment. Afterwards: rm -rf "$READMESHOTS_ROOT" ~/Library/WebKit/coool-readme-shots
# ~/Library/Caches/coool-readme-shots (the script does it unless READMESHOTS_KEEP=1).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ROOT=${READMESHOTS_ROOT:-/private/tmp/coool-readme-shots}
NAME=coool-readme-shots
MEDIA="$REPO/docs/media"

if [ "${READMESHOTS_BUILD:-0}" = 1 ]; then
  pnpm -C "$REPO/app" build
  (cd "$REPO" && cargo build -p coool-app --features tauri/custom-protocol)
fi
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN, or READMESHOTS_BUILD=1)"; exit 1; }

# 1. The workspace, from scratch (only ever a folder this script made).
if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.coool-readme-shots" ] || { echo "$ROOT exists and isn't ours; remove it or set READMESHOTS_ROOT"; exit 1; }
  rm -rf "$ROOT"
fi
python3 -I "$HERE/workspace.py" build --root "$ROOT"
touch "$ROOT/.coool-readme-shots"
cp "$HERE/standin-claude.py" "$ROOT/bin/claude"
printf '#!/bin/sh\nexit 1\n' > "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
mkdir -p "$ROOT/app" "$ROOT/shots" "$ROOT/logs"
cp "$BIN" "$ROOT/app/$NAME"
H="$ROOT/home"
case "$H" in /Users/*) echo "refusing a HOME under /Users"; exit 1 ;; esac

# The page's own storage (theme, glass) starts empty, so every run looks the same.
rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"

# 2. Live sessions.
python3 -I "$HERE/workspace.py" live --root "$ROOT" > "$ROOT/logs/live.pid" 2> "$ROOT/logs/live.err" &
LIVE=$!
sleep 1

# 3. The app, with a minimal environment: nothing of the person's (API keys, CLAUDE_* / CODEX_* settings) reaches it.
LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST=readme-shots COOOL_SELFTEST_DIR="$H/code" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_BACKGROUND=1 COOOL_GLASS_ACTIVE=1 \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

i=0
while [ $i -lt 300 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
kill $LIVE 2>/dev/null || true
wait $LIVE 2>/dev/null || true
grep -E 'PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"

# 4. The pictures.
ok=1
for n in mission-dark mission-light approval-dark needs-dark agents-dark; do
  if [ -f "$ROOT/shots/real-readme-$n.png" ]; then
    cp "$ROOT/shots/real-readme-$n.png" "$MEDIA/$n.png"
    echo "docs/media/$n.png  $(sips -g pixelWidth -g pixelHeight "$MEDIA/$n.png" | awk '/pixel/ {printf "%s ", $2}')"
  else
    echo "missing: $n"; ok=0
  fi
done

if [ "${READMESHOTS_KEEP:-0}" != 1 ]; then
  rm -rf "$ROOT" "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
fi
[ $ok = 1 ]
