#!/bin/sh
# coool installer for macOS on Apple silicon.
#
#   curl -fsSL https://raw.githubusercontent.com/mes28io/coool/master/scripts/install.sh | sh
#
# Downloads the latest release, checks its SHA-256, and puts coool.app in /Applications (or ~/Applications when
# /Applications isn't writable). Nothing runs as root. A file fetched by curl carries no quarantine flag, so macOS
# opens the app without the "unidentified developer" block even though the build isn't notarised.
#
# Overrides (mostly for testing):
#   COOOL_VERSION   a release tag such as v0.1.0 (default: the latest release)
#   COOOL_BASE_URL  where coool-macos-arm64.tar.gz and its .sha256 live (default: the GitHub release)
#   COOOL_DIR       the folder to install into
set -eu

REPO="mes28io/coool"
ASSET="coool-macos-arm64.tar.gz"

say() { printf '%s\n' "$*"; }
die() { printf 'coool install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "coool runs on macOS only."
[ "$(uname -m)" = "arm64" ] || die "coool needs an Apple silicon Mac (M1 or later)."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 13 ] || die "coool needs macOS 13 or later (this Mac has $(sw_vers -productVersion))."

if [ -n "${COOOL_BASE_URL:-}" ]; then
  base="$COOOL_BASE_URL"
elif [ -n "${COOOL_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$COOOL_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

if [ -n "${COOOL_DIR:-}" ]; then
  dir="$COOOL_DIR"
elif [ -w /Applications ]; then
  dir="/Applications"
else
  dir="$HOME/Applications"
fi
mkdir -p "$dir" || die "can't create $dir"
dest="$dir/coool.app"

if pgrep -f "$dest/Contents/MacOS/coool" >/dev/null 2>&1; then
  die "coool is running from $dest. Quit it, then run this again."
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/coool-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading coool from $base"
curl -fL --progress-bar -o "$tmp/$ASSET" "$base/$ASSET" || die "download failed: $base/$ASSET"
curl -fsSL -o "$tmp/$ASSET.sha256" "$base/$ASSET.sha256" || die "download failed: $base/$ASSET.sha256"

want=$(cut -d' ' -f1 < "$tmp/$ASSET.sha256")
got=$(shasum -a 256 "$tmp/$ASSET" | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || die "checksum mismatch (expected $want, got $got). Nothing was installed."

mkdir "$tmp/x"
tar -xzf "$tmp/$ASSET" -C "$tmp/x" || die "the download couldn't be unpacked"
[ -x "$tmp/x/coool.app/Contents/MacOS/coool" ] || die "the download doesn't contain coool.app"
codesign --verify --deep "$tmp/x/coool.app" 2>/dev/null || die "the app's signature didn't verify. Nothing was installed."
xattr -dr com.apple.quarantine "$tmp/x/coool.app" 2>/dev/null || true

if [ -e "$dest" ]; then
  rm -rf "$dest" || die "can't replace $dest"
fi
mv "$tmp/x/coool.app" "$dest" || die "can't write to $dir"

ver=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$dest/Contents/Info.plist" 2>/dev/null || echo "?")
say ""
say "coool $ver is installed at $dest"
say "Open it with:  open \"$dest\""
if ! command -v claude >/dev/null 2>&1 && ! command -v codex >/dev/null 2>&1; then
  say ""
  say "coool drives the Claude Code and Codex CLIs, and neither is on your PATH yet."
  say "Install and sign in to at least one of them first."
fi
