#!/bin/sh
# The New session sheet end to end in the real app (self-test scenario `newsession`, app/src/selftestNewSession.ts), on
# the invented workspace of app/scripts/readme-shots (projects as real git repositories with Claude Code and Codex
# sessions) and the stand-in CLIs (no model, no network, no account):
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/newsession-e2e.sh
#
# Everything lives under $NEWSESSION_ROOT (default /private/tmp/coool-newsession-e2e): a throwaway HOME (so the folder
# index, Desktop and ~/.claude are the workspace's own, and macOS never asks about the person's real Desktop), the log
# and the screenshots. The window stays off screen (COOOL_SELFTEST_BACKGROUND=1). Besides the workspace, the HOME gets
# a Desktop with folders, ignored folders holding repositories (node_modules, Library) and a repository 4 deep in
# ~/code (found) next to one 5 deep (not). Afterwards it checks the folder the sheet made and the worktree with git.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${NEWSESSION_ROOT:-/private/tmp/coool-newsession-e2e}
NAME=coool-newsession-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
case "$ROOT" in /private/tmp/coool-newsession-*|/tmp/coool-newsession-*) ;; *) echo "NEWSESSION_ROOT must be under /tmp/coool-newsession-"; exit 1 ;; esac

rm -rf "$ROOT"
python3 -I "$HERE/readme-shots/workspace.py" build --root "$ROOT" > /dev/null
H="$ROOT/home"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"

g() { env -i HOME="$H" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 git -C "$1" -c init.defaultBranch=main -c user.name=t -c user.email=t@coool.invalid -c commit.gpgsign=false "$2" ${3:+"$3"} ${4:+"$4"}; }
mkrepo() { mkdir -p "$1"; g "$1" init -q; echo x > "$1/README.md"; g "$1" add -A; g "$1" commit -qm "start"; }
mkdir -p "$H/Desktop/old-notes" "$H/Desktop/screens" "$H/Documents/Writing" "$H/Downloads"
mkrepo "$H/code/deep/a/b/deep-repo"
mkrepo "$H/code/deep/a/b/c/too-deep"
mkrepo "$H/code/web/node_modules/pkg"
mkrepo "$H/Library/Hidden/repo-in-library"
mkrepo "$H/Desktop/desk-repo"

rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST=newsession COOOL_SELFTEST_DIR="$H/code" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_BACKGROUND=1 \
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
grep -E 'PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"

echo "--- afterwards"
ok=1
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; ok=0; fi; }
check "the sheet made ~/code/made-by-sheet as a git repository" "$([ -d "$H/code/made-by-sheet/.git" ] && echo yes || echo no)" "yes"
check "nothing made outside home" "$([ -e /private/tmp/coool-should-not-exist ] && echo made || echo none)" "none"
check "no folder made in Library" "$([ -e "$H/Library/x" ] && echo made || echo none)" "none"
check "pixelforge got a .coool worktree, excluded from git status" "$(ls "$H/code/pixelforge/.coool/worktrees" 2>/dev/null | wc -l | tr -d ' ') $(g "$H/code/pixelforge" status --porcelain | grep -c coool || true)" "1 0"
echo "shots: $ROOT/shots"
ls "$ROOT/shots"
[ $ok = 1 ]
