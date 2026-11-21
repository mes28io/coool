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
key_item=coool-release-signing-key-locked
# The key comes from one of two places. Safest: it lives in a password manager, not on this Mac, and is pasted at the
# hidden prompt below when releasing. Otherwise: the Keychain item, which should be locked so every read asks for the
# login password (scripts/release-key.sh makes it that way).
key_from=prompt
security find-generic-password -s "$key_item" >/dev/null 2>&1 && key_from=keychain
if [ "$key_from" = prompt ] && [ ! -t 0 ]; then
  echo "package.sh: no release signing key in the Keychain ($key_item) and no terminal to paste it into." >&2
  exit 1
fi

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
# Signed with the owner's self-signed "coool release signing" certificate (private key non-exportable, in the login
# Keychain; public cert in scripts/coool-release-signing.cer.pem). The designated requirement is then the bundle id AND
# that certificate, so macOS privacy grants (Files & Folders, Full Disk Access) survive updates while no other program
# can claim them. Ad-hoc signing (a per-build hash) lost the grants on every update; an id-only requirement would let
# any ad-hoc program named sh.coool.app inherit them. COOOL_SIGN_IDENTITY=- falls back to ad-hoc (local builds only).
sign_id="${COOOL_SIGN_IDENTITY:-9A2CC611EEAC050D80C78C8D283A3853AA4BBF86}"
codesign --force --deep --sign "$sign_id" "$app"
codesign --verify --deep --strict "$app"
if [ "$sign_id" != "-" ]; then
  codesign -d -r- "$app" 2>&1 | grep -q 'certificate leaf = H"9a2cc611eeac050d80c78c8d283a3853aa4bbf86"' || {
    echo "package.sh: the app is not signed with the coool release certificate" >&2
    exit 1
  }
fi

mkdir -p dist
out="dist/coool-macos-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$(dirname "$app")" coool.app
( cd dist && shasum -a 256 coool-macos-arm64.tar.gz > coool-macos-arm64.tar.gz.sha256 )
# The secret key goes from the Keychain to the signer on stdin (never to a file); the signer keeps the signature only
# if a key pinned in the app verifies it.
if [ "$key_from" = keychain ]; then
  security find-generic-password -s "$key_item" -w | cargo run -q -p coool-app --example sign_release -- sign "$out" app/src-tauri/src/update/keys.rs
else
  printf 'Paste the release signing key (nothing is shown), then press Return: ' >&2
  stty -echo; IFS= read -r pasted_key; stty echo; printf '\n' >&2
  printf '%s\n' "$pasted_key" | cargo run -q -p coool-app --example sign_release -- sign "$out" app/src-tauri/src/update/keys.rs
  unset pasted_key
fi
ver=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
echo "Packed coool $ver: $out ($(du -h "$out" | cut -f1))"
cat dist/coool-macos-arm64.tar.gz.sha256
echo "Attach dist/coool-macos-arm64.tar.gz, .sha256 and .minisig to the release."
