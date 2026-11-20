#!/bin/sh
# Makes coool's release signing key, once, on the release Mac:
#   - the secret key goes into your login Keychain as the item `coool-release-signing-key-locked` (and nowhere else: back it
#     up offline, e.g. `security find-generic-password -s coool-release-signing-key-locked -w` into a password manager);
#   - its public key is pinned in the app (app/src-tauri/src/update/keys.rs) and written to scripts/coool-release.pub
#     (for checking a signature by hand: `minisign -Vm coool-macos-arm64.tar.gz -p scripts/coool-release.pub`).
# Commit both files. Releases are then signed by scripts/package.sh. Refuses to replace an existing key; to rotate,
# see keys.rs.
set -eu
cd "$(dirname "$0")/.."
ITEM=coool-release-signing-key-locked
if security find-generic-password -s "$ITEM" >/dev/null 2>&1; then
  echo "release-key.sh: the Keychain already holds $ITEM; not replacing it." >&2
  exit 1
fi
out=$(cargo run -q -p coool-app --example sign_release -- keygen)
pub=$(printf '%s\n' "$out" | sed -n 's/^public //p')
sec=$(printf '%s\n' "$out" | sed -n 's/^secret //p')
[ -n "$pub" ] && [ -n "$sec" ] || { echo "release-key.sh: key generation failed" >&2; exit 1; }
# Through `security -i` on stdin, so the secret never shows in a process list.
# `-T ""`: no program is trusted with this item, so every read shows the Keychain's password dialog (answer Allow,
# never Always Allow). Without it, anything running as you could read the key silently.
printf 'add-generic-password -a coool -s %s -l "coool release signing key" -T "" -w %s\n' "$ITEM" "$sec" | security -i
security find-generic-password -s "$ITEM" >/dev/null 2>&1 || { echo "release-key.sh: the key did not reach the Keychain" >&2; exit 1; }
unset sec out
keys=app/src-tauri/src/update/keys.rs
awk -v k="$pub" '
  /^pub const PINNED: &\[&str\] = &\[\];$/ { print "pub const PINNED: &[&str] = &[\"" k "\"];"; next }
  /^pub const PINNED: &\[&str\] = &\[/ { sub(/\];$/, ", \"" k "\"];"); print; next }
  { print }
' "$keys" > "$keys.tmp" && mv "$keys.tmp" "$keys"
printf 'untrusted comment: coool release signing key\n%s\n' "$pub" > scripts/coool-release.pub
echo "Made the release signing key. Keychain item: $ITEM. Public key (pinned in $keys): $pub"
