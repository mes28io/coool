#!/bin/sh
# Builds the release coool.app and packs it for scripts/install.sh:
#   dist/coool-macos-arm64.tar.gz and dist/coool-macos-arm64.tar.gz.sha256
# Attach both files to a GitHub release. The build is ad-hoc signed (no Apple Developer ID, no notarisation), which
# is enough for an app installed by the curl command; a copy downloaded in a browser would be blocked by Gatekeeper.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
target="${CARGO_TARGET_DIR:-$root/target}"
[ "$(uname -m)" = "arm64" ] || { echo "package.sh: build on an Apple silicon Mac" >&2; exit 1; }

pnpm -C app tauri build --bundles app
app="$target/release/bundle/macos/coool.app"
[ -d "$app" ] || { echo "package.sh: $app is missing" >&2; exit 1; }
# One signature over the whole bundle, so the installer's `codesign --verify --deep` has something to check.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

mkdir -p dist
out="dist/coool-macos-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$(dirname "$app")" coool.app
( cd dist && shasum -a 256 coool-macos-arm64.tar.gz > coool-macos-arm64.tar.gz.sha256 )
ver=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
echo "Packed coool $ver: $out ($(du -h "$out" | cut -f1))"
cat dist/coool-macos-arm64.tar.gz.sha256
