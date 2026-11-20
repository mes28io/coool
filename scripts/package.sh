#!/bin/sh
# Builds the release coool.app and packs it for scripts/install.sh:
#   dist/coool-macos-arm64.tar.gz, its .sha256 (a corruption check) and its .minisig (the signature the app checks
#   before it installs an update, made with the key in this Mac's Keychain: scripts/release-key.sh)
# Attach all three files to a GitHub release. The build is ad-hoc signed (no Apple Developer ID, no notarisation), which
# is enough for an app installed by the curl command; a copy downloaded in a browser would be blocked by Gatekeeper.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
target="${CARGO_TARGET_DIR:-$root/target}"
[ "$(uname -m)" = "arm64" ] || { echo "package.sh: build on an Apple silicon Mac" >&2; exit 1; }
key_item=coool-release-signing-key
security find-generic-password -s "$key_item" >/dev/null 2>&1 || {
  echo "package.sh: no release signing key in the Keychain ($key_item). Run sh scripts/release-key.sh once on the release Mac." >&2
  exit 1
}

# Keep this Mac's home folder (and so the account name) out of the binary: panic messages and C asserts embed
# source paths otherwise.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"
export CFLAGS="${CFLAGS:-} -ffile-prefix-map=$HOME=~"
export CXXFLAGS="${CXXFLAGS:-} -ffile-prefix-map=$HOME=~"
pnpm -C app tauri build --bundles app
if strings "$target/release/bundle/macos/coool.app/Contents/MacOS/coool" | grep -q "$HOME"; then
  echo "package.sh: the binary still contains $HOME" >&2
  exit 1
fi
app="$target/release/bundle/macos/coool.app"
[ -d "$app" ] || { echo "package.sh: $app is missing" >&2; exit 1; }
# One signature over the whole bundle, so the installer's `codesign --verify --deep` has something to check.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

mkdir -p dist
out="dist/coool-macos-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$(dirname "$app")" coool.app
( cd dist && shasum -a 256 coool-macos-arm64.tar.gz > coool-macos-arm64.tar.gz.sha256 )
# The secret key goes from the Keychain to the signer on stdin (never to a file); the signer keeps the signature only
# if a key pinned in the app verifies it.
security find-generic-password -s "$key_item" -w | cargo run -q -p coool-app --example sign_release -- sign "$out" app/src-tauri/src/update/keys.rs
ver=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
echo "Packed coool $ver: $out ($(du -h "$out" | cut -f1))"
cat dist/coool-macos-arm64.tar.gz.sha256
echo "Attach dist/coool-macos-arm64.tar.gz, .sha256 and .minisig to the release."
