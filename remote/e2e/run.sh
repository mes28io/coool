#!/bin/sh
# coool Remote end to end: the real app (self-test scenario `remote`, app/src/selftestRemote.ts) and the stand-in
# phone (remote/phone/e2e.mjs) against the relay's dev deployment, with three short Claude Haiku turns.
#
#   remote/e2e/run.sh [out]        (default /tmp/coool-remote-e2e)
#
# COOOL_BIN: a self-test build (`pnpm -C app build && cargo build -p coool-app --features tauri/custom-protocol`),
# default $CARGO_TARGET_DIR/debug/coool. The app runs as a renamed copy (its own WebKit data store), off screen and
# never focused, with Remote's state and keys in the run's folder (never the Keychain). HOME stays the real one, for
# the Claude CLI's login; the self-test lists only the sessions in its own folder, and the scenario checks that only
# those (and invented ones) reach the phone. Afterwards: rm -rf ~/Library/WebKit/coool-remote-e2e
# ~/Library/Caches/coool-remote-e2e.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
OUT=${1:-/tmp/coool-remote-e2e}
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-target}/debug/coool}
rm -rf "$OUT"
mkdir -p "$OUT/remote-e2e-proj" "$OUT/bin" "$OUT/shots"
OUT=$(cd "$OUT" && pwd -P)
PROJ="$OUT/remote-e2e-proj"
cp "$BIN" "$OUT/bin/coool-remote-e2e"
COOOL_SELFTEST=remote COOOL_SELFTEST_DIR="$PROJ" COOOL_SELFTEST_LOG="$OUT/selftest.log" COOOL_SELFTEST_SHOTS="$OUT/shots" \
  COOOL_SELFTEST_BACKGROUND=1 "$OUT/bin/coool-remote-e2e" > "$OUT/app.out" 2>&1 &
APP=$!
node "$HERE/../phone/e2e.mjs" "$PROJ" > "$OUT/phone.log" 2>&1 &
PHONE=$!
echo "app pid $APP, phone pid $PHONE, folder $OUT"
i=0
while [ $i -lt 1200 ] && ! grep -q ' END$' "$OUT/selftest.log" 2>/dev/null; do
  if ! kill -0 $APP 2>/dev/null; then
    echo "app exited early (see $OUT/app.out)"
    break
  fi
  sleep 1
  i=$((i + 1))
done
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
j=0
while [ $j -lt 20 ] && kill -0 $PHONE 2>/dev/null; do sleep 1; j=$((j + 1)); done
kill $PHONE 2>/dev/null || true
wait $PHONE 2>/dev/null || true
echo "--- app"
cat "$OUT/selftest.log"
echo "--- phone"
tail -n 40 "$OUT/phone.log"
