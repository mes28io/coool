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
: "${SIM:?set SIM to the udid of your test simulator}"
rm -rf "$OUT"
mkdir -p "$OUT/remote-e2e-proj" "$OUT/bin" "$OUT/shots" "$OUT/phone-shots" "$OUT/site" "$OUT/attach"
OUT=$(cd "$OUT" && pwd -P)
PROJ="$OUT/remote-e2e-proj"
cp "$BIN" "$OUT/bin/coool-remote-ios-e2e"
xcrun simctl boot "$SIM" 2>/dev/null || true
# An invented local page for the chat's Browser panel (minor 1: the phone watches it as pictures); a clock that ticks,
# so successive pictures differ. SITE_PORT: any free port of yours (default 5391).
SITE_PORT=${SITE_PORT:-5391}
cat > "$OUT/site/remote.html" <<'HTML'
<!doctype html><title>Remote frame test</title><body style="font:32px -apple-system;margin:40px;background:#f7f6f3">
<h1>Remote frame test</h1><p>An invented page. <b id="t">0</b> s</p><div id="bar" style="height:20px;background:#0a84ff;width:10px"></div>
<script>let n=0;setInterval(()=>{n++;t.textContent=n;bar.style.width=(10+(n*25)%400)+"px"},1000)</script>
HTML
python3 -m http.server "$SITE_PORT" --bind 127.0.0.1 --directory "$OUT/site" > "$OUT/site.log" 2>&1 &
SITE=$!
COOOL_VOICE_MODEL="${VOICE_MODEL:-}" COOOL_ATTACH_DIR="$OUT/attach" COOOL_SELFTEST_SITE="http://127.0.0.1:$SITE_PORT" \
COOOL_REMOTE_RELAY="${COOOL_REMOTE_RELAY:-https://abundant-ostrich-973.eu-west-1.convex.cloud}" COOOL_SELFTEST=remote COOOL_SELFTEST_DIR="$PROJ" COOOL_SELFTEST_LOG="$OUT/selftest.log" COOOL_SELFTEST_SHOTS="$OUT/shots" \
  COOOL_SELFTEST_BACKGROUND=1 "$OUT/bin/coool-remote-ios-e2e" > "$OUT/app.out" 2>&1 &
APP=$!
# Minor 2: a text file the phone attaches, and a recording it sends for dictation (the Simulator has no microphone:
# the app hands this file over where a recording would be). The speech is made here with `say`, as AAC at 16 kHz
# mono, the phone's own format. VOICE_MODEL: a whisper model for the Mac's dictation (read only).
mkdir -p "$OUT/phone-files"
printf '# Notes from the phone\nThe magic word is heliotrope.\n' > "$OUT/phone-files/notes-from-phone.md"
say -o "$OUT/phone-files/speech.aiff" "Ask cool to add a retry with backoff to the upload client."
afconvert -f m4af -d aac@16000 -c 1 -b 24000 "$OUT/phone-files/speech.aiff" "$OUT/phone-files/speech.m4a"
rm -f "$OUT/phone-files/speech.aiff"
TEST_RUNNER_COOOL_E2E_DIR="$PROJ" TEST_RUNNER_COOOL_E2E_SHOTS="$OUT/phone-shots" \
  TEST_RUNNER_COOOL_E2E_FILE="$OUT/phone-files/notes-from-phone.md" TEST_RUNNER_COOOL_E2E_AUDIO="$OUT/phone-files/speech.m4a" \
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
kill $SITE 2>/dev/null || true
echo "--- app"
cat "$OUT/selftest.log"
echo "--- phone"
grep -E "E2E |Test Case|TEST (SUCCEEDED|FAILED)|error:" "$OUT/phone.log" | tail -n 40
