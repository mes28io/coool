#!/bin/sh
# The Changes view end to end in the real app (self-test scenarios `changes` and `changes-codex`, app/src/selftestChanges.ts),
# on a scratch git repository with the stand-in CLIs of app/scripts/readme-shots (no model, no network, no account):
#
#   COOOL_BIN=<debug build with the current frontend> sh app/scripts/changes-e2e.sh
#
# Everything lives under $CHANGES_ROOT (default /private/tmp/coool-changes-e2e): a throwaway HOME (so ~/.claude and
# ~/.codex are the stand-ins' own), the repository at $HOME/code/repo, the log and the screenshots. The window stays off
# screen (COOOL_SELFTEST_BACKGROUND=1). When the log says `HAND-EDIT a.txt` this script edits a.txt itself, as the
# person would. Afterwards it checks the repository with git: the commit, what is staged, the files undone.
# One side effect outside the folder: the undone new file goes to the Trash (NSFileManager), as it would for the person.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
ROOT=${CHANGES_ROOT:-/private/tmp/coool-changes-e2e}
NAME=coool-changes-e2e
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-$REPO/target}/debug/coool}
[ -x "$BIN" ] || { echo "no binary at $BIN (set COOOL_BIN)"; exit 1; }
case "$ROOT" in /private/tmp/coool-changes-*|/tmp/coool-changes-*) ;; *) echo "CHANGES_ROOT must be under /tmp/coool-changes-"; exit 1 ;; esac

rm -rf "$ROOT"
H="$ROOT/home"
W="$H/code/repo"
mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/shots" "$ROOT/logs" "$W"
cp "$HERE/readme-shots/standin-claude.py" "$ROOT/bin/claude"
cp "$HERE/readme-shots/standin-codex.py" "$ROOT/bin/codex"
chmod +x "$ROOT/bin/claude" "$ROOT/bin/codex"
cp "$BIN" "$ROOT/app/$NAME"

g() { env -i HOME="$H" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 git -C "$W" "$@"; }
g init -q -b main
g config user.name "coool test"
g config user.email "test@coool.invalid"
g config commit.gpgsign false
i=1; while [ $i -le 40 ]; do echo "line $i"; i=$((i + 1)); done > "$W/a.txt"
printf 'alpha\nbeta\n' > "$W/b.txt"
printf 'beta\ngamma\ndelta\nepsilon\n' > "$W/c.txt"
g add -A
g commit -q -m "start"

rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
LOG="$ROOT/logs/selftest.log"
env -i HOME="$H" USER="${USER:-demo}" LOGNAME="${LOGNAME:-demo}" TMPDIR="${TMPDIR:-/tmp/}" LANG=en_US.UTF-8 SHELL=/bin/zsh \
  PATH="$ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  COOOL_SELFTEST="${CHANGES_SCENARIOS:-changes,changes-codex}" COOOL_SELFTEST_DIR="$W" COOOL_SELFTEST_SHOTS="$ROOT/shots" COOOL_SELFTEST_LOG="$LOG" \
  COOOL_SELFTEST_BACKGROUND=1 \
  "$ROOT/app/$NAME" > "$ROOT/logs/app.out" 2>&1 &
APP=$!

edited=0
i=0
while [ $i -lt 240 ] && ! grep -q ' END$' "$LOG" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then echo "the app exited early (see $ROOT/logs/app.out)"; break; fi
  if [ $edited = 0 ] && grep -q 'HAND-EDIT a.txt' "$LOG" 2>/dev/null; then
    # The person's own edit, in the agent's line.
    perl -pi -e 's/^line two$/line two, edited by hand/' "$W/a.txt"
    edited=1
  fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
grep -E 'PASS|FAIL|WARN|SUMMARY' "$LOG" || cat "$LOG"

echo "--- git, afterwards"
ok=1
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; ok=0; fi; }
check "last commit message" "$(g log -1 --format=%s)" "Rename line 2 in a.txt (coool self-test)"
check "the commit changed a.txt only" "$(g show --name-only --format= HEAD | tr '\n' ' ')" "a.txt "
check "a.txt in the commit: the agent's line 2, the person's edit, line 30 undone" "$(g show HEAD:a.txt | sed -n '2p;30p' | tr '\n' '|')" "line two, edited by hand|line 30|"
check "nothing staged after the commit" "$(g diff --cached --name-only)" ""
check "b.txt kept, not staged, still changed" "$(g status --porcelain -- b.txt)" " M b.txt"
check "notes/new.txt undone (gone from the tree)" "$([ -e "$W/notes/new.txt" ] && echo present || echo gone)" "gone"
if grep -q 'changes-codex' "$LOG"; then
  check "c.txt back as it was (Codex patch undone)" "$(g status --porcelain -- c.txt)" ""
  check "d.txt kept (untracked, still there)" "$(g status --porcelain -- d.txt)" "?? d.txt"
fi
echo "shots: $ROOT/shots"
ls "$ROOT/shots"
[ "${CHANGES_KEEP:-0}" = 1 ] || rm -rf "$HOME/Library/WebKit/$NAME" "$HOME/Library/Caches/$NAME"
grep -q 'fail=0' "$LOG" && [ $ok = 1 ]
