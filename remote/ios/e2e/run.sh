#!/bin/sh
# coool Remote end to end with the iPhone app: the real Mac app (self-test scenario `remote`,
# app/src/selftestRemote.ts) and this app in the iOS Simulator, driven by XCUITest (UITests/EndToEndTests.swift)
# in place of the stand-in phone, against the relay's dev deployment, with three short Claude Haiku turns.
#
#   SIM=<simulator udid> remote/ios/e2e/run.sh [out]        (default /tmp/coool-ios-e2e)
#
# SIM: a simulator of your own (not one another tool uses); it is booted headless if needed.
# COOOL_BIN: a self-test build of the Mac app (see remote/e2e/run.sh), default $CARGO_TARGET_DIR/debug/coool.
# DERIVED: xcodebuild's DerivedData for this project (built with `build-for-testing` first), default
# remote/ios/.build/dd. The Mac app runs as a renamed copy, off screen and never focused, with Remote's state in the
# run's folder. Afterwards: rm -rf ~/Library/WebKit/coool-remote-ios-e2e ~/Library/Caches/coool-remote-ios-e2e.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
OUT=${1:-/tmp/coool-ios-e2e}
BIN=${COOOL_BIN:-${CARGO_TARGET_DIR:-target}/debug/coool}
DERIVED=${DERIVED:-$HERE/../.build/dd}
: "${SIM:?set SIM to your simulator's udid}"
rm -rf "$OUT"
mkdir -p "$OUT/remote-e2e-proj" "$OUT/bin" "$OUT/shots" "$OUT/phone-shots"
OUT=$(cd "$OUT" && pwd -P)
PROJ="$OUT/remote-e2e-proj"
cp "$BIN" "$OUT/bin/coool-remote-ios-e2e"
xcrun simctl boot "$SIM" 2>/dev/null || true
COOOL_SELFTEST=remote COOOL_SELFTEST_DIR="$PROJ" COOOL_SELFTEST_LOG="$OUT/selftest.log" COOOL_SELFTEST_SHOTS="$OUT/shots" \
  COOOL_SELFTEST_BACKGROUND=1 "$OUT/bin/coool-remote-ios-e2e" > "$OUT/app.out" 2>&1 &
APP=$!
TEST_RUNNER_COOOL_E2E_DIR="$PROJ" TEST_RUNNER_COOOL_E2E_SHOTS="$OUT/phone-shots" \
  xcodebuild test-without-building -project "$HERE/../CooolRemote.xcodeproj" -scheme CooolRemote \
  -destination "id=$SIM" -derivedDataPath "$DERIVED" -only-testing:CooolRemoteUITests/EndToEndTests \
  > "$OUT/phone.log" 2>&1 &
PHONE=$!
echo "app pid $APP, phone (xcodebuild) pid $PHONE, folder $OUT"
i=0
while [ $i -lt 1500 ] && ! grep -q ' END$' "$OUT/selftest.log" 2>/dev/null; do
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
while [ $j -lt 120 ] && kill -0 $PHONE 2>/dev/null; do sleep 1; j=$((j + 1)); done
kill $PHONE 2>/dev/null || true
wait $PHONE 2>/dev/null || true
echo "--- app"
cat "$OUT/selftest.log"
echo "--- phone"
grep -E "E2E |Test Case|TEST (SUCCEEDED|FAILED)|error:" "$OUT/phone.log" | tail -n 40
