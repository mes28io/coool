//! The release signing keys coool trusts: minisign public keys (base64, the second line of a `minisign.pub`).
//!
//! A coool update is installed only when its tarball's `.minisig` verifies against one of these. More than one may
//! be listed so the key can be rotated: ship a release that pins the old and the new key, sign later releases with
//! the new one, then drop the old key from a later release.
//!
//! The matching secret key lives only in the Keychain of the release Mac (item `coool-release-signing-key`), made by
//! `sh scripts/release-key.sh`, which also writes its public key here. Back it up offline. While this list is empty,
//! no update can be verified, so none is installed.

pub const PINNED: &[&str] = &[];
