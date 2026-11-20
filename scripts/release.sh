#!/bin/sh
# Sets coool's version everywhere it lives, then (unless --no-package) builds the release package.
#
#   sh scripts/release.sh 0.2.0              # set 0.2.0, then run scripts/package.sh
#   sh scripts/release.sh 0.2.0 --no-package # only set the version
#
# The version is written to app/src-tauri/tauri.conf.json (what the app reports and the in-app updater compares),
# app/package.json, and the [package] version of every crate in the workspace (Cargo.lock follows). It must be a
# plain semantic version, and newer than the current one: the in-app updater never offers the same or an older one.
# Nothing is committed, tagged or published: the steps after are printed at the end.
set -eu
cd "$(dirname "$0")/.."

die() { printf 'release.sh: %s\n' "$*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: sh scripts/release.sh <version> [--no-package]"
ver="${1#v}"
package=1
[ "${2:-}" = "--no-package" ] && package=0

printf '%s' "$ver" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$' || die "not a semantic version: $ver"
old=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' app/src-tauri/tauri.conf.json | head -1)
[ -n "$old" ] || die "can't read the current version from app/src-tauri/tauri.conf.json"
if [ "$old" = "$ver" ]; then
  die "the version is already $ver"
fi
# Newer, by semver: a higher MAJOR.MINOR.PATCH, or the same one going from a pre-release to a later pre-release or
# to the release itself.
oc="${old%%-*}"
nc="${ver%%-*}"
later() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$2" ]; }
if [ "$oc" = "$nc" ]; then
  case "$old" in *-*) ;; *) die "$ver is not newer than $old" ;; esac
  if [ "$ver" != "$nc" ] && ! later "$old" "$ver"; then die "$ver is not newer than $old"; fi
elif ! later "$oc" "$nc"; then
  die "$ver is not newer than $old"
fi

# tauri.conf.json and package.json: the top-level "version" line.
for f in app/src-tauri/tauri.conf.json app/package.json; do
  sed -i '' "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"$ver\",/" "$f"
  grep -q "^  \"version\": \"$ver\",\$" "$f" || die "couldn't set the version in $f"
done
# Each crate's own version: the first `version = ` line, inside [package].
for f in app/src-tauri/Cargo.toml crates/core/Cargo.toml crates/tui/Cargo.toml crates/whisper/Cargo.toml; do
  awk -v v="$ver" '
    /^\[/ { inpkg = ($0 == "[package]") }
    inpkg && !done && /^version = "/ { print "version = \"" v "\""; done = 1; next }
    { print }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  grep -q "^version = \"$ver\"\$" "$f" || die "couldn't set the version in $f"
done
# Cargo.lock: the workspace's own entries (the `version` line after their `name`), as cargo would write them.
awk -v v="$ver" '
  /^name = "(coool-app|coool-core|coool|coool-whisper)"$/ { own = 1; print; next }
  own && /^version = "/ { print "version = \"" v "\""; own = 0; next }
  { own = own && !/^$/; print }
' Cargo.lock > Cargo.lock.tmp && mv Cargo.lock.tmp Cargo.lock

echo "coool's version: $old -> $ver"
if [ "$package" = 1 ]; then
  sh scripts/package.sh
fi
cat <<EOF

Next:
  git commit -am "coool $ver" && git tag v$ver && git push && git push origin v$ver
  gh release create v$ver dist/coool-macos-arm64.tar.gz dist/coool-macos-arm64.tar.gz.sha256 dist/coool-macos-arm64.tar.gz.minisig --title "coool $ver" --notes "..."
Installed copies find it at their next check (launch, or a few times a day) and install it.
EOF
