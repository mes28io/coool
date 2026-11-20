//! The coool Remote protocol, version 1 (docs/REMOTE.md "Pairing", "Messages", "Relay requests"): the Mac's half.
//!
//! Mirrors remote/phone/src/protocol.mjs byte for byte; tests/vectors.json holds fixed-input results both sides
//! check. All cryptography comes from x25519-dalek, ed25519-dalek, hkdf, hmac, sha2 and chacha20poly1305.

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

pub const VERSION: u32 = 1;
pub const PROTOCOL: &str = "coool-remote/1";

type HmacSha256 = Hmac<Sha256>;

pub fn b64u(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

/// Strict base64url (no padding, canonical); `len`: the exact byte count wanted.
pub fn unb64u(s: &str, len: Option<usize>) -> Result<Vec<u8>> {
    let b = URL_SAFE_NO_PAD.decode(s).map_err(|_| anyhow!("not base64url"))?;
    if len.is_some_and(|n| n != b.len()) {
        bail!("wrong length");
    }
    if b64u(&b) != s {
        bail!("not canonical base64url");
    }
    Ok(b)
}

pub fn key32(s: &str) -> Result<[u8; 32]> {
    let v = unb64u(s, Some(32))?;
    let mut k = [0u8; 32];
    k.copy_from_slice(&v);
    Ok(k)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// 128 random bits as 32 lowercase hex characters.
pub fn random_id() -> String {
    hex(&random_bytes::<16>())
}

pub fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn sha256_hex(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

fn hkdf32(ikm: &[u8], info: &str) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(PROTOCOL.as_bytes()), ikm).expand(info.as_bytes(), out.as_mut()).expect("32 bytes is a valid HKDF length");
    out
}

fn hmac(key: &[u8], msg: &str) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(msg.as_bytes());
    m.finalize().into_bytes().into()
}

// ---------------------------------------------------------------- identity

/// The Mac's long-term keys. The private halves are zeroed when dropped.
pub struct Identity {
    box_priv: x25519_dalek::StaticSecret,
    sign: SigningKey,
}

impl Identity {
    pub fn generate() -> Self {
        let mut a = random_bytes::<32>();
        let mut b = random_bytes::<32>();
        let id = Self::from_raw(&a, &b);
        a.zeroize();
        b.zeroize();
        id
    }

    pub fn from_raw(box_priv: &[u8; 32], sign_seed: &[u8; 32]) -> Self {
        Identity { box_priv: x25519_dalek::StaticSecret::from(*box_priv), sign: SigningKey::from_bytes(sign_seed) }
    }

    /// The form kept in the key store: `v1.<x25519 private>.<ed25519 seed>`, base64url. Printable ASCII only.
    pub fn export(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("v1.{}.{}", b64u(self.box_priv.as_bytes()), b64u(self.sign.as_bytes())))
    }

    pub fn import(s: &str) -> Result<Self> {
        let mut parts = s.trim().split('.');
        let (Some("v1"), Some(a), Some(b), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
            bail!("unrecognised key format");
        };
        let mut a = key32(a)?;
        let mut b = key32(b)?;
        let id = Self::from_raw(&a, &b);
        a.zeroize();
        b.zeroize();
        Ok(id)
    }

    pub fn box_pub(&self) -> String {
        b64u(x25519_dalek::PublicKey::from(&self.box_priv).as_bytes())
    }

    pub fn sign_pub(&self) -> String {
        b64u(self.sign.verifying_key().as_bytes())
    }

    pub fn sign(&self, bytes: &[u8]) -> String {
        b64u(&self.sign.sign(bytes).to_bytes())
    }

    /// X25519 with a peer, refusing a low-order key (an all-zero shared secret).
    pub fn shared(&self, peer_box_pub: &str) -> Result<Zeroizing<[u8; 32]>> {
        let peer = x25519_dalek::PublicKey::from(key32(peer_box_pub)?);
        let s = self.box_priv.diffie_hellman(&peer);
        if !s.was_contributory() {
            bail!("low-order public key");
        }
        Ok(Zeroizing::new(*s.as_bytes()))
    }
}

pub fn verify(sign_pub: &str, sig: &str, bytes: &[u8]) -> bool {
    let (Ok(k), Ok(s)) = (key32(sign_pub), unb64u(sig, Some(64))) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&k) else { return false };
    let Ok(sig) = Signature::from_slice(&s) else { return false };
    vk.verify_strict(bytes, &sig).is_ok()
}

// ---------------------------------------------------------------- pairing

pub struct PairingKeys {
    pub relay: Zeroizing<[u8; 32]>,
    pub mac: Zeroizing<[u8; 32]>,
    pub name: Zeroizing<[u8; 32]>,
    pub code: Zeroizing<[u8; 32]>,
}

pub fn pairing_keys(secret: &[u8]) -> PairingKeys {
    PairingKeys {
        relay: hkdf32(secret, &format!("{PROTOCOL} relay-proof")),
        mac: hkdf32(secret, &format!("{PROTOCOL} mac-proof")),
        name: hkdf32(secret, &format!("{PROTOCOL} claim-name")),
        code: hkdf32(secret, &format!("{PROTOCOL} code")),
    }
}

/// A phone's claim of a pairing, as the relay forwards it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub pairing_id: String,
    pub device_id: String,
    pub sign_pub: String,
    pub box_pub: String,
    pub name_box: String,
    pub proof_mac: String,
}

pub fn claim_transcript(c: &Claim) -> String {
    [PROTOCOL, "claim", &c.pairing_id, &c.device_id, &c.sign_pub, &c.box_pub, &c.name_box].join("\n")
}

pub fn proof(key: &[u8], c: &Claim) -> String {
    b64u(&hmac(key, &claim_transcript(c)))
}

/// The claim's proof for the Mac, checked in constant time.
pub fn proof_ok(key: &[u8], c: &Claim) -> bool {
    let Ok(given) = unb64u(&c.proof_mac, Some(32)) else { return false };
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(claim_transcript(c).as_bytes());
    m.verify_slice(&given).is_ok()
}

fn name_aad(pairing_id: &str, device_id: &str) -> String {
    [PROTOCOL, "name", pairing_id, device_id].join("\n")
}

pub fn open_name(name_key: &[u8], pairing_id: &str, device_id: &str, sealed: &str) -> Result<String> {
    let b = unb64u(sealed, None)?;
    if b.len() < 28 {
        bail!("short");
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(name_key));
    let aad = name_aad(pairing_id, device_id);
    let pt = cipher.decrypt(Nonce::from_slice(&b[..12]), Payload { msg: &b[12..], aad: aad.as_bytes() }).map_err(|_| anyhow!("the device name does not decrypt"))?;
    Ok(String::from_utf8(pt)?)
}

#[cfg(test)]
pub fn seal_name(name_key: &[u8], pairing_id: &str, device_id: &str, name: &str, nonce: [u8; 12]) -> String {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(name_key));
    let aad = name_aad(pairing_id, device_id);
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: name.as_bytes(), aad: aad.as_bytes() }).expect("encrypt");
    b64u(&[&nonce[..], &ct].concat())
}

pub struct CodeInput<'a> {
    pub pairing_id: &'a str,
    pub mac_id: &'a str,
    pub mac_sign_pub: &'a str,
    pub mac_box_pub: &'a str,
    pub device_id: &'a str,
    pub dev_sign_pub: &'a str,
    pub dev_box_pub: &'a str,
}

/// The 6-digit code both ends show.
pub fn pairing_code(code_key: &[u8], p: &CodeInput) -> String {
    let t = [PROTOCOL, "code", p.pairing_id, p.mac_id, p.mac_sign_pub, p.mac_box_pub, p.device_id, p.dev_sign_pub, p.dev_box_pub].join("\n");
    let h = hmac(code_key, &t);
    format!("{:06}", u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000)
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The QR code's payload (`coool://pair?...`), encoded as URLSearchParams encodes it.
pub fn pair_url(relay: &str, mac_id: &str, pairing_id: &str, secret: &str, mac_sign_pub: &str, mac_box_pub: &str) -> String {
    format!("coool://pair?v={VERSION}&r={}&m={mac_id}&p={pairing_id}&s={secret}&ks={mac_sign_pub}&kx={mac_box_pub}", enc(relay))
}

// ---------------------------------------------------------------- messages

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    M2d,
    D2m,
}

impl Dir {
    pub fn as_str(self) -> &'static str {
        match self {
            Dir::M2d => "m2d",
            Dir::D2m => "d2m",
        }
    }
}

/// Per-direction keys between this Mac and one device.
pub struct SessionKeys {
    pub m2d: Zeroizing<[u8; 32]>,
    pub d2m: Zeroizing<[u8; 32]>,
}

pub fn session_keys(shared: &[u8], mac_id: &str, device_id: &str, mac_box_pub: &str, dev_box_pub: &str) -> SessionKeys {
    let ctx = |dir: &str| [PROTOCOL, "session", dir, mac_id, device_id, mac_box_pub, dev_box_pub].join(" ");
    SessionKeys { m2d: hkdf32(shared, &ctx("m2d")), d2m: hkdf32(shared, &ctx("d2m")) }
}

fn nonce_of(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

fn message_aad(dir: Dir, mac_id: &str, device_id: &str, counter: u64) -> String {
    [PROTOCOL, "msg", dir.as_str(), mac_id, device_id, &counter.to_string()].join("\n")
}

/// Largest counter both sides can carry exactly (JavaScript numbers, Convex's float64).
pub const MAX_COUNTER: u64 = (1 << 53) - 1;

/// The next counter to send: above the last, and at least the time in microseconds, so a counter never repeats
/// under a key even if the stored one was lost.
pub fn next_counter(last: u64, now_ms: u64) -> u64 {
    (last + 1).max(now_ms.saturating_mul(1000))
}

pub fn seal(key: &[u8], dir: Dir, mac_id: &str, device_id: &str, counter: u64, plaintext: &[u8]) -> Result<String> {
    if counter == 0 || counter > MAX_COUNTER {
        bail!("counter out of range");
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let aad = message_aad(dir, mac_id, device_id, counter);
    let ct = cipher.encrypt(Nonce::from_slice(&nonce_of(counter)), Payload { msg: plaintext, aad: aad.as_bytes() }).map_err(|_| anyhow!("encrypt failed"))?;
    Ok(b64u(&ct))
}

/// Decrypts; any change to the key, counter, routing fields or bytes fails.
pub fn open(key: &[u8], dir: Dir, mac_id: &str, device_id: &str, counter: u64, ciphertext: &str) -> Result<Vec<u8>> {
    let b = unb64u(ciphertext, None)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let aad = message_aad(dir, mac_id, device_id, counter);
    cipher.decrypt(Nonce::from_slice(&nonce_of(counter)), Payload { msg: &b, aad: aad.as_bytes() }).map_err(|_| anyhow!("does not decrypt"))
}

/// A plaintext message: `{v, id, t, at, b}`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Envelope {
    pub v: u32,
    pub id: String,
    pub t: String,
    /// The sender's clock, epoch milliseconds.
    pub at: u64,
    #[serde(default)]
    pub b: serde_json::Value,
}

impl Envelope {
    pub fn new(t: &str, b: serde_json::Value, at: u64) -> Self {
        Envelope { v: VERSION, id: uuid(), t: t.into(), at, b }
    }
}

fn uuid() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The bytes a relay request's signature covers (remote/relay/convex/lib.ts `signedBytes`).
pub fn request_bytes(fun: &str, fields: &[&str], ts: u64) -> Vec<u8> {
    let ts = ts.to_string();
    let mut parts = vec![PROTOCOL, fun];
    parts.extend_from_slice(fields);
    parts.push(&ts);
    parts.join("\n").into_bytes()
}
