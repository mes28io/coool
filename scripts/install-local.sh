#!/bin/sh
# Builds coool from this checkout and installs it into /Applications, for the person who owns the repo.
# No release, no signing key, no network: the bundle is ad-hoc signed. Quit coool first; the script refuses to
# replace a running app.
#   sh scripts/install-local.sh
set -eu
cd "$(dirname "$0")/.."
target="${CARGO_TARGET_DIR:-$(pwd)/target}"
dest="/Applications/coool.app"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"
export CFLAGS="${CFLAGS:-} -ffile-prefix-map=$HOME=~"
export CXXFLAGS="${CXXFLAGS:-} -ffile-prefix-map=$HOME=~"
pnpm -C app tauri build --bundles app
app="$target/release/bundle/macos/coool.app"
[ -d "$app" ] || { echo "install-local.sh: $app is missing" >&2; exit 1; }
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
if pgrep -f "$dest/Contents/MacOS/coool" >/dev/null 2>&1; then
  echo "Built: $app"
  echo "coool is running. Quit it, then run:  rm -rf \"$dest\" && cp -R \"$app\" \"$dest\""
  exit 2
fi
rm -rf "$dest"
cp -R "$app" "$dest"
echo "Installed coool $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$dest/Contents/Info.plist") at $dest"
