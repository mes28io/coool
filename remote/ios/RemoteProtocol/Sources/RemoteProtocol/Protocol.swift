// coool Remote protocol, version 1: the phone's side (docs/REMOTE.md), following remote/phone/src/protocol.mjs.
//
// Pure functions over bytes and strings: keys, the pairing proofs and code, message sealing, relay request
// signatures, the QR payload. No I/O. All cryptography is CryptoKit: X25519, Ed25519, HKDF-SHA256, HMAC-SHA256,
// ChaCha20-Poly1305. Nothing here implements a primitive.
//
// Encodings: ids are 32 lowercase hex characters (128 random bits); keys, signatures, proofs and ciphertext are
// base64url without padding. crates/remote/tests/vectors.json holds results the Node, Rust and Swift sides all
// reproduce (Tests/RemoteProtocolTests).

import CryptoKit
import Foundation

public enum Remote {
  public static let version = 1
  public static let proto = "coool-remote/1"
  /// Counters stay below 2^53 so JavaScript numbers and Convex's float64 carry them exactly.
  public static let maxCounter: UInt64 = (1 << 53) - 1
}

public enum ProtocolError: Error, Equatable, Sendable {
  case notBase64url
  case wrongLength
  case notPairingLink
  case wrongVersion(Int)
  case badPairingLink
  case badRelayAddress
  case lowOrderKey
  case badKey
  case doesNotOpen
  case badCounter
}

// ---------------------------------------------------------------- encodings

public enum B64U {
  public static func encode(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Decodes canonical base64url without padding; `length`, if given, is the exact byte count expected.
  public static func decode(_ s: String, length: Int? = nil) throws -> Data {
    guard s.utf8.allSatisfy({ isB64UChar($0) }) else { throw ProtocolError.notBase64url }
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    if t.count % 4 == 1 { throw ProtocolError.notBase64url }
    while t.count % 4 != 0 { t += "=" }
    guard let d = Data(base64Encoded: t) else { throw ProtocolError.notBase64url }
    if let length, d.count != length { throw ProtocolError.wrongLength }
    guard encode(d) == s else { throw ProtocolError.notBase64url }
    return d
  }

  private static func isB64UChar(_ c: UInt8) -> Bool {
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 95
  }
}

public func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }

public func randomBytes(_ n: Int) -> Data {
  var g = SystemRandomNumberGenerator()
  return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
}

/// A random 128-bit id as 32 lowercase hex characters.
public func randomId() -> String { hex(randomBytes(16)) }

public func isId(_ s: String) -> Bool {
  s.utf8.count == 32 && s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
}

func utf8(_ s: String) -> Data { Data(s.utf8) }

// ---------------------------------------------------------------- keys

/// An identity: an X25519 key (encryption) and an Ed25519 key (signing), raw 32-byte private halves.
public struct Identity: Codable, Equatable, Sendable {
  public var boxPriv: Data
  public var signPriv: Data

  public init(boxPriv: Data, signPriv: Data) throws {
    _ = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: boxPriv)
    _ = try Curve25519.Signing.PrivateKey(rawRepresentation: signPriv)
    self.boxPriv = boxPriv
    self.signPriv = signPriv
  }

  public static func generate() -> Identity {
    // Freshly generated keys always round-trip.
    try! Identity(
      boxPriv: Curve25519.KeyAgreement.PrivateKey().rawRepresentation,
      signPriv: Curve25519.Signing.PrivateKey().rawRepresentation)
  }

  public var boxPub: String { B64U.encode(try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: boxPriv).publicKey.rawRepresentation) }
  public var signPub: String { B64U.encode(try! Curve25519.Signing.PrivateKey(rawRepresentation: signPriv).publicKey.rawRepresentation) }

  /// An Ed25519 signature (base64url). CryptoKit's signatures are randomized (hedged), so two signatures of the
  /// same bytes differ; any of them verifies, which is all the relay checks.
  public func sign(_ bytes: Data) -> String {
    B64U.encode(try! Curve25519.Signing.PrivateKey(rawRepresentation: signPriv).signature(for: bytes))
  }
}

public func verify(signPub: String, signature: String, bytes: Data) -> Bool {
  guard let pub = try? B64U.decode(signPub, length: 32), let sig = try? B64U.decode(signature, length: 64),
    let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub)
  else { return false }
  return key.isValidSignature(sig, for: bytes)
}

func hkdf(_ ikm: Data, _ label: String) -> Data {
  let k = HKDF<SHA256>.deriveKey(
    inputKeyMaterial: SymmetricKey(data: ikm), salt: utf8(Remote.proto), info: utf8("\(Remote.proto) \(label)"),
    outputByteCount: 32)
  return k.withUnsafeBytes { Data($0) }
}

func hmac(_ key: Data, _ msg: String) -> Data {
  Data(HMAC<SHA256>.authenticationCode(for: utf8(msg), using: SymmetricKey(data: key)))
}

/// X25519, refusing a low-order peer key (an all-zero shared secret).
public func sharedSecret(boxPriv: Data, peerBoxPub: String) throws -> Data {
  guard let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: B64U.decode(peerBoxPub, length: 32)),
    let priv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: boxPriv)
  else { throw ProtocolError.badKey }
  // CryptoKit itself throws on a low-order point; the zero check is the protocol's rule, kept explicit.
  guard let s = try? priv.sharedSecretFromKeyAgreement(with: pub) else { throw ProtocolError.lowOrderKey }
  let raw = s.withUnsafeBytes { Data($0) }
  if raw.allSatisfy({ $0 == 0 }) { throw ProtocolError.lowOrderKey }
  return raw
}

// ---------------------------------------------------------------- pairing

/// The keys a pairing secret yields. `relayKey` goes to the relay; the others never leave the two ends.
public struct PairingKeys: Sendable {
  public let relayKey, macKey, nameKey, codeKey: Data
  public init(secret: Data) {
    relayKey = hkdf(secret, "relay-proof")
    macKey = hkdf(secret, "mac-proof")
    nameKey = hkdf(secret, "claim-name")
    codeKey = hkdf(secret, "code")
  }
}

public struct Claim: Equatable, Sendable {
  public var pairingId, deviceId, signPub, boxPub, nameBox: String
  public var proofRelay = "", proofMac = ""

  public init(pairingId: String, deviceId: String, signPub: String, boxPub: String, nameBox: String) {
    self.pairingId = pairingId
    self.deviceId = deviceId
    self.signPub = signPub
    self.boxPub = boxPub
    self.nameBox = nameBox
  }

  public var transcript: String { [Remote.proto, "claim", pairingId, deviceId, signPub, boxPub, nameBox].joined(separator: "\n") }
  public func proof(_ key: Data) -> String { B64U.encode(hmac(key, transcript)) }
  /// The fields in the order `claimPairing` signs them.
  public var fields: [String] { [pairingId, deviceId, signPub, boxPub, nameBox, proofRelay, proofMac] }
}

func nameAad(_ pairingId: String, _ deviceId: String) -> Data { utf8([Remote.proto, "name", pairingId, deviceId].joined(separator: "\n")) }

/// The device name, sealed for the Mac under the pairing's name key: nonce ‖ ciphertext ‖ tag.
public func sealName(nameKey: Data, pairingId: String, deviceId: String, name: String, nonce: Data = randomBytes(12)) throws -> String {
  let box = try ChaChaPoly.seal(
    utf8(name), using: SymmetricKey(data: nameKey), nonce: ChaChaPoly.Nonce(data: nonce), authenticating: nameAad(pairingId, deviceId))
  return B64U.encode(box.combined)
}

public func openName(nameKey: Data, pairingId: String, deviceId: String, box: String) throws -> String {
  let b = try B64U.decode(box)
  guard b.count >= 28, let sealed = try? ChaChaPoly.SealedBox(combined: b),
    let pt = try? ChaChaPoly.open(sealed, using: SymmetricKey(data: nameKey), authenticating: nameAad(pairingId, deviceId)),
    let s = String(data: pt, encoding: .utf8)
  else { throw ProtocolError.doesNotOpen }
  return s
}

public struct CodeInput: Sendable {
  public var pairingId, macId, macSignPub, macBoxPub, deviceId, devSignPub, devBoxPub: String
  public init(pairingId: String, macId: String, macSignPub: String, macBoxPub: String, deviceId: String, devSignPub: String, devBoxPub: String) {
    self.pairingId = pairingId
    self.macId = macId
    self.macSignPub = macSignPub
    self.macBoxPub = macBoxPub
    self.deviceId = deviceId
    self.devSignPub = devSignPub
    self.devBoxPub = devBoxPub
  }
}

/// The 6-digit code both ends show: from the pairing secret and both sides' public keys.
public func pairingCode(codeKey: Data, _ p: CodeInput) -> String {
  let t = [Remote.proto, "code", p.pairingId, p.macId, p.macSignPub, p.macBoxPub, p.deviceId, p.devSignPub, p.devBoxPub].joined(separator: "\n")
  let h = hmac(codeKey, t)
  let n = h.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) } % 1_000_000
  let s = String(n)
  return String(repeating: "0", count: 6 - s.count) + s
}

/// `coool://pair?...`: what the Mac's QR code holds.
public struct PairLink: Equatable, Sendable {
  public var relay, macId, pairingId, secret, macSignPub, macBoxPub: String

  public init(relay: String, macId: String, pairingId: String, secret: String, macSignPub: String, macBoxPub: String) {
    self.relay = relay
    self.macId = macId
    self.pairingId = pairingId
    self.secret = secret
    self.macSignPub = macSignPub
    self.macBoxPub = macBoxPub
  }

  static let prefix = "coool://pair?"

  /// The link as the Mac writes it (`URLSearchParams` encoding).
  public var url: String {
    let pairs = [("v", String(Remote.version)), ("r", relay), ("m", macId), ("p", pairingId), ("s", secret), ("ks", macSignPub), ("kx", macBoxPub)]
    return Self.prefix + pairs.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&")
  }

  public static func parse(_ raw: String) throws -> PairLink {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard s.hasPrefix(prefix) else { throw ProtocolError.notPairingLink }
    var q: [String: String] = [:]
    for part in s.dropFirst(prefix.count).split(separator: "&", omittingEmptySubsequences: true) {
      let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      let k = formDecode(String(kv[0]))
      // URLSearchParams.get returns the first value of a key.
      if q[k] == nil { q[k] = kv.count > 1 ? formDecode(String(kv[1])) : "" }
    }
    let v = Int(q["v"] ?? "") ?? 0
    guard v == Remote.version else { throw ProtocolError.wrongVersion(v) }
    let l = PairLink(relay: q["r"] ?? "", macId: q["m"] ?? "", pairingId: q["p"] ?? "", secret: q["s"] ?? "", macSignPub: q["ks"] ?? "", macBoxPub: q["kx"] ?? "")
    guard isId(l.macId), isId(l.pairingId) else { throw ProtocolError.badPairingLink }
    do {
      _ = try B64U.decode(l.secret, length: 32)
      _ = try B64U.decode(l.macSignPub, length: 32)
      _ = try B64U.decode(l.macBoxPub, length: 32)
    } catch { throw ProtocolError.badPairingLink }
    guard isRelayAddress(l.relay) else { throw ProtocolError.badRelayAddress }
    return l
  }
}

/// `https://host[:port][/]`, as protocol.mjs checks it.
public func isRelayAddress(_ s: String) -> Bool {
  guard s.hasPrefix("https://") else { return false }
  var rest = Substring(s.dropFirst(8))
  if rest.hasSuffix("/") { rest = rest.dropLast() }
  let parts = rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
  let host = parts[0]
  guard !host.isEmpty, host.utf8.allSatisfy({ ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 46 || $0 == 45 }) else { return false }
  if parts.count == 2 { return !parts[1].isEmpty && parts[1].utf8.allSatisfy { $0 >= 48 && $0 <= 57 } }
  return true
}

/// application/x-www-form-urlencoded, as `URLSearchParams` serializes it.
func formEncode(_ s: String) -> String {
  var out = ""
  for b in s.utf8 {
    switch b {
    case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2A, 0x2D, 0x2E, 0x5F: out.append(Character(UnicodeScalar(b)))
    case 0x20: out.append("+")
    default: out += String(format: "%%%02X", b)
    }
  }
  return out
}

func formDecode(_ s: String) -> String {
  let bytes = Array(s.utf8)
  var out: [UInt8] = []
  var i = 0
  while i < bytes.count {
    let b = bytes[i]
    if b == 0x2B {
      out.append(0x20)
    } else if b == 0x25, i + 2 < bytes.count, let v = UInt8(String(decoding: bytes[(i + 1)...(i + 2)], as: UTF8.self), radix: 16) {
      out.append(v)
      i += 2
    } else {
      out.append(b)
    }
    i += 1
  }
  return String(decoding: out, as: UTF8.self)
}

// ---------------------------------------------------------------- messages

public enum Dir: String, Codable, Sendable { case m2d, d2m }

/// Per-direction keys for one Mac and one device.
public struct SessionKeys: Sendable {
  public let m2d: Data
  public let d2m: Data
  public init(shared: Data, macId: String, deviceId: String, macBoxPub: String, devBoxPub: String) {
    // Info `coool-remote/1 session <dir> <macId> <deviceId> <Mac X25519 public> <device X25519 public>`
    // (`hkdf` puts the protocol name in front).
    func label(_ dir: String) -> String { ["session", dir, macId, deviceId, macBoxPub, devBoxPub].joined(separator: " ") }
    m2d = hkdf(shared, label("m2d"))
    d2m = hkdf(shared, label("d2m"))
  }
}

public func nonce(counter: UInt64) -> Data {
  var n = Data(count: 4)
  withUnsafeBytes(of: counter.bigEndian) { n.append(contentsOf: $0) }
  return n
}

public func messageAad(_ dir: Dir, _ macId: String, _ deviceId: String, _ counter: UInt64) -> Data {
  utf8([Remote.proto, "msg", dir.rawValue, macId, deviceId, String(counter)].joined(separator: "\n"))
}

/// The next counter to send: above the last one, and at least the current time in microseconds (so a counter never
/// repeats under a key even if the stored one was lost).
public func nextCounter(last: UInt64, nowMs: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)) -> UInt64 {
  max(last + 1, nowMs * 1000)
}

/// Seals plaintext bytes: base64url of ciphertext ‖ tag; the nonce is the counter.
public func seal(key: Data, dir: Dir, macId: String, deviceId: String, counter: UInt64, plaintext: Data) throws -> String {
  guard counter <= Remote.maxCounter else { throw ProtocolError.badCounter }
  let box = try ChaChaPoly.seal(plaintext, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce(counter: counter)), authenticating: messageAad(dir, macId, deviceId, counter))
  return B64U.encode(box.ciphertext + box.tag)
}

/// Decrypts; throws on any tampering (wrong key, counter, routing fields or bytes).
public func open(key: Data, dir: Dir, macId: String, deviceId: String, counter: UInt64, ciphertext: String) throws -> Data {
  guard let b = try? B64U.decode(ciphertext), b.count >= 16,
    let box = try? ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce(counter: counter)), ciphertext: b.dropLast(16), tag: b.suffix(16)),
    let pt = try? ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: messageAad(dir, macId, deviceId, counter))
  else { throw ProtocolError.doesNotOpen }
  return pt
}

/// Remembers the highest counter accepted from one sender: a counter at or below it is a replay.
public struct ReplayGuard: Equatable, Sendable {
  public private(set) var highWater: UInt64
  public init(highWater: UInt64 = 0) { self.highWater = highWater }
  public mutating func accept(_ counter: UInt64) -> Bool {
    guard counter <= Remote.maxCounter, counter > highWater else { return false }
    highWater = counter
    return true
  }
}

// ---------------------------------------------------------------- relay requests

/// What a relay request signs: the protocol, the function name, its fields in order and `ts`, joined by newlines.
public func requestBytes(_ fn: String, _ fields: [String], ts: Int64) -> Data {
  utf8(([Remote.proto, fn] + fields + [String(ts)]).joined(separator: "\n"))
}

public func sha256Hex(_ s: String) -> String { hex(SHA256.hash(data: utf8(s))) }

/// A read-session token and the hash the relay keeps.
public func newToken() -> (token: String, tokenHash: String) {
  let t = B64U.encode(randomBytes(32))
  return (t, sha256Hex(t))
}
