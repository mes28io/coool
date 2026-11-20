// The messages (docs/REMOTE.md "Messages"): the plaintext envelope, what the Mac sends and what the phone may send,
// and the device's end of a pairing (`Link`): sealing what it sends and taking what its inbox holds, with the
// replay guard. Still no I/O: the app moves the bytes.

import Foundation

// ---------------------------------------------------------------- JSON

/// Any JSON value, so a message body survives a round trip whatever the sender's version put in it.
public enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n):
      if n.rounded() == n, abs(n) < 9.007_199_254_740_992e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }
  public var string: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  static let decoder: JSONDecoder = {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
  }()

  /// This value as a `Decodable` (snake_case keys become camelCase).
  public func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try Self.decoder.decode(T.self, from: JSONEncoder().encode(self))
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral {
  public init(booleanLiteral v: Bool) { self = .bool(v) }
  public init(floatLiteral v: Double) { self = .number(v) }
  public init(stringLiteral v: String) { self = .string(v) }
  public init(dictionaryLiteral els: (String, JSONValue)...) { self = .object(Dictionary(els, uniquingKeysWith: { a, _ in a })) }
  public init(arrayLiteral els: JSONValue...) { self = .array(els) }
  public init(integerLiteral v: Int) { self = .number(Double(v)) }
}

// ---------------------------------------------------------------- the envelope

/// A plaintext message: `{v, id, t, at, b}`: version, a random id (what a `result` names), type, the sender's clock
/// in epoch ms, and the body.
public struct Envelope: Codable, Equatable, Sendable {
  public var v: Int
  public var id: String
  public var t: String
  public var at: Int64
  public var b: JSONValue

  public init(v: Int = Remote.version, id: String = UUID().uuidString.lowercased(), t: String, at: Int64 = nowMs(), b: JSONValue = .object([:])) {
    self.v = v
    self.id = id
    self.t = t
    self.at = at
    self.b = b
  }

  public func json() throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.withoutEscapingSlashes]
    return try e.encode(self)
  }

  public static func parse(_ data: Data) throws -> Envelope { try JSONDecoder().decode(Envelope.self, from: data) }
}

public func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

// ---------------------------------------------------------------- what the Mac sends

public enum Cli: String, Codable, Sendable, CaseIterable { case claude, codex }

/// One session as the phone sees it (`snapshot`, `session`). States: working, waiting (needs you), idle, ended.
public struct SessionInfo: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var project: String
  public var cli: Cli
  public var state: String
  public var model: String
  public var lastActivity: Double
  /// A chat coool runs: one a `send` or `stop` can reach.
  public var chat: Bool

  public init(id: String, title: String, project: String, cli: Cli, state: String, model: String = "", lastActivity: Double = 0, chat: Bool) {
    self.id = id
    self.title = title
    self.project = project
    self.cli = cli
    self.state = state
    self.model = model
    self.lastActivity = lastActivity
    self.chat = chat
  }
}

public struct Question: Codable, Equatable, Sendable {
  public var question: String
  public var options: [String]
  public var multi: Bool
  public var allowOther: Bool
}

/// A pending request: kind "permission", "plan" or "question".
public struct Need: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var session: String
  public var kind: String
  public var tool: String
  public var summary: String
  public var command: String?
  public var questions: [Question]
  public var explanation: String?
  public var risk: String?

  public init(id: String, session: String, kind: String, tool: String, summary: String, command: String? = nil, questions: [Question] = [], explanation: String? = nil, risk: String? = nil) {
    self.id = id
    self.session = session
    self.kind = kind
    self.tool = tool
    self.summary = summary
    self.command = command
    self.questions = questions
    self.explanation = explanation
    self.risk = risk
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    session = try c.decode(String.self, forKey: .session)
    kind = try c.decode(String.self, forKey: .kind)
    tool = try c.decode(String.self, forKey: .tool)
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
    command = try c.decodeIfPresent(String.self, forKey: .command)
    questions = try c.decodeIfPresent([Question].self, forKey: .questions) ?? []
    explanation = try c.decodeIfPresent(String.self, forKey: .explanation)
    risk = try c.decodeIfPresent(String.self, forKey: .risk)
  }
}

/// A folder a chat can start in. `id` is opaque: the phone never sees or sends a path.
public struct Project: Codable, Equatable, Sendable, Identifiable, Hashable {
  public var id: String
  public var name: String
  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// One line of a chat's tail: role "user", "assistant", "tool" or "notice".
public struct ChatItem: Codable, Equatable, Sendable {
  public var role: String
  public var text: String?
  public var tool: String?
  public init(role: String, text: String? = nil, tool: String? = nil) {
    self.role = role
    self.text = text
    self.tool = tool
  }
}

/// The Mac's answer to a command: `{of, t, ok, error?}`, plus `session` and `mode` for a `start`.
public struct CommandResult: Codable, Equatable, Sendable {
  public var of: String
  public var t: String
  public var ok: Bool
  public var error: String?
  public var session: String?
  public var mode: String?
}

/// A message from the Mac, typed. Unknown types are ignored (`unknown`), so the Mac can be newer.
public enum Inbound: Equatable, Sendable {
  case snapshot(sessions: [SessionInfo], needs: [Need])
  case session(SessionInfo)
  case sessionGone(String)
  case need(Need)
  case needGone(String)
  case chatTail(session: String, items: [ChatItem])
  case result(CommandResult)
  case projects([Project])
  case unknown(String)
  /// A known type whose body this version can't read: ignored as well, but worth a log line.
  case malformed(String)

  private struct Snap: Decodable { var sessions: [SessionInfo]; var needs: [Need]? }
  private struct Tail: Decodable { var session: String; var items: [ChatItem] }
  private struct Projects: Decodable { var projects: [Project] }

  public static func from(_ e: Envelope) -> Inbound {
    do {
      switch e.t {
      case "snapshot":
        let s = try e.b.decode(Snap.self)
        return .snapshot(sessions: s.sessions, needs: s.needs ?? [])
      case "session":
        if case .bool(true) = e.b["gone"], let id = e.b["id"]?.string { return .sessionGone(id) }
        return .session(try e.b.decode(SessionInfo.self))
      case "need": return .need(try e.b.decode(Need.self))
      case "need_gone":
        guard let id = e.b["id"]?.string else { return .malformed(e.t) }
        return .needGone(id)
      case "chat_tail":
        let t = try e.b.decode(Tail.self)
        return .chatTail(session: t.session, items: t.items)
      case "result": return .result(try e.b.decode(CommandResult.self))
      case "projects": return .projects(try e.b.decode(Projects.self).projects)
      default: return .unknown(e.t)
      }
    } catch {
      return .malformed(e.t)
    }
  }
}

// ---------------------------------------------------------------- what the phone may send

/// What an answer can say, and nothing else: there is no "always allow" and no mode to change.
public enum Choice: Equatable, Sendable {
  case allowOnce
  case deny
  /// One label of the first question.
  case option(String)
  /// Per question, the picked labels (or typed text where the question takes it).
  case answers([[String]])
}

public enum Command: Equatable, Sendable {
  case hello(name: String)
  case getSnapshot
  case getChat(session: String, n: Int = 30)
  case answer(need: String, Choice)
  case send(session: String, text: String)
  case stop(session: String)
  /// Only a project from the Mac's own list (`projects`): the phone never names a path.
  case start(Project, Cli, text: String)

  public var type: String {
    switch self {
    case .hello: "hello"
    case .getSnapshot: "get_snapshot"
    case .getChat: "get_chat"
    case .answer: "answer"
    case .send: "send"
    case .stop: "stop"
    case .start: "start"
    }
  }

  public var body: JSONValue {
    switch self {
    case .hello(let name): ["name": .string(name)]
    case .getSnapshot: [:]
    case .getChat(let s, let n): ["session": .string(s), "n": .number(Double(n))]
    case .answer(let need, let c):
      switch c {
      case .allowOnce: ["need": .string(need), "choice": "allow_once"]
      case .deny: ["need": .string(need), "choice": "deny"]
      case .option(let o): ["need": .string(need), "choice": "option", "option": .string(o)]
      case .answers(let a): ["need": .string(need), "choice": "answers", "answers": .array(a.map { .array($0.map(JSONValue.string)) })]
      }
    case .send(let s, let text): ["session": .string(s), "text": .string(text)]
    case .stop(let s): ["session": .string(s)]
    case .start(let p, let cli, let text): ["project": .string(p.id), "cli": .string(cli.rawValue), "text": .string(text)]
    }
  }

  public func envelope(at: Int64 = nowMs()) -> Envelope { Envelope(t: type, at: at, b: body) }
}

// ---------------------------------------------------------------- the device's end of a pairing

/// What the phone keeps once paired. The app stores it in the Keychain (this device only).
public struct PairedMac: Codable, Equatable, Sendable {
  public var relay: String
  public var name: String
  public var deviceId: String
  public var identity: Identity
  public var macId: String
  public var macSignPub: String
  public var macBoxPub: String
  public var pairedAt: Int64

  public init(relay: String, name: String, deviceId: String, identity: Identity, macId: String, macSignPub: String, macBoxPub: String, pairedAt: Int64 = nowMs()) {
    self.relay = relay
    self.name = name
    self.deviceId = deviceId
    self.identity = identity
    self.macId = macId
    self.macSignPub = macSignPub
    self.macBoxPub = macBoxPub
    self.pairedAt = pairedAt
  }
}

/// A claim ready for `claimPairing`, the code to show, and what to keep once the Mac confirms.
public struct PendingClaim: Sendable {
  public let link: PairLink
  public let claim: Claim
  public let code: String
  public let paired: PairedMac

  /// Builds a claim for `link` with a new identity and device id (or the given ones, for tests).
  public init(link: PairLink, name: String, identity: Identity = .generate(), deviceId: String = randomId(), nonce: Data = randomBytes(12)) throws {
    let k = PairingKeys(secret: try B64U.decode(link.secret, length: 32))
    var c = Claim(pairingId: link.pairingId, deviceId: deviceId, signPub: identity.signPub, boxPub: identity.boxPub,
                  nameBox: try sealName(nameKey: k.nameKey, pairingId: link.pairingId, deviceId: deviceId, name: name, nonce: nonce))
    c.proofRelay = c.proof(k.relayKey)
    c.proofMac = c.proof(k.macKey)
    self.link = link
    self.claim = c
    self.code = pairingCode(codeKey: k.codeKey, CodeInput(pairingId: link.pairingId, macId: link.macId, macSignPub: link.macSignPub, macBoxPub: link.macBoxPub, deviceId: deviceId, devSignPub: identity.signPub, devBoxPub: identity.boxPub))
    self.paired = PairedMac(relay: link.relay, name: name, deviceId: deviceId, identity: identity, macId: link.macId, macSignPub: link.macSignPub, macBoxPub: link.macBoxPub)
  }
}

/// One queued message as `deviceInbox` returns it.
public struct Queued: Decodable, Equatable, Sendable {
  public var counter: Double
  public var ciphertext: String
  public var createdAt: Double?
  public init(counter: Double, ciphertext: String, createdAt: Double? = nil) {
    self.counter = counter
    self.ciphertext = ciphertext
    self.createdAt = createdAt
  }
}

/// `deviceInbox`'s answer: `{ok: true, messages, macLastSeen}` or `{ok: false, code}`.
public struct InboxResult: Decodable, Equatable, Sendable {
  public var ok: Bool
  public var code: String?
  public var messages: [Queued]?
  public var macLastSeen: Double?
  public init(ok: Bool, code: String? = nil, messages: [Queued]? = nil, macLastSeen: Double? = nil) {
    self.ok = ok
    self.code = code
    self.messages = messages
    self.macLastSeen = macLastSeen
  }
}

/// Where the link stands after an inbox update or a refused request.
public enum LinkStatus: Equatable, Sendable {
  case ok
  /// The read session ended (expired, or deleted when the device was removed): open a new one. If that is refused
  /// as revoked, the Mac removed this phone.
  case sessionEnded
  /// The Mac removed this phone: forget the pairing and go back to pairing, saying why.
  case revoked
}

/// Relay refusal codes that mean this device is gone for good.
public func isRevocation(_ code: String?) -> Bool { code == "revoked" || code == "unknown_device" }

public struct InboxOutcome: Equatable, Sendable {
  public var status: LinkStatus = .ok
  /// Decrypted messages, in counter order, each once.
  public var messages: [Inbound] = []
  /// Counters that didn't open (tampered, misrouted, or not for this key): dropped.
  public var refused: [UInt64] = []
  /// What to acknowledge (everything seen, handled or dropped), if anything.
  public var ackUpTo: UInt64?
  public var macLastSeen: Int64?
}

public struct Link: Sendable {
  public let mac: PairedMac
  let keys: SessionKeys
  public private(set) var recv: ReplayGuard
  public private(set) var sendCounter: UInt64

  public init(_ mac: PairedMac, recvHighWater: UInt64 = 0, sendCounter: UInt64 = 0) throws {
    self.mac = mac
    let shared = try sharedSecret(boxPriv: mac.identity.boxPriv, peerBoxPub: mac.macBoxPub)
    keys = SessionKeys(shared: shared, macId: mac.macId, deviceId: mac.deviceId, macBoxPub: mac.macBoxPub, devBoxPub: mac.identity.boxPub)
    recv = ReplayGuard(highWater: recvHighWater)
    self.sendCounter = sendCounter
  }

  /// Seals one envelope for the Mac under the next counter.
  public mutating func seal(_ env: Envelope, nowMs now: UInt64 = UInt64(nowMs())) throws -> (counter: UInt64, ciphertext: String) {
    let c = nextCounter(last: sendCounter, nowMs: now)
    let ct = try RemoteProtocol.seal(key: keys.d2m, dir: .d2m, macId: mac.macId, deviceId: mac.deviceId, counter: c, plaintext: try env.json())
    sendCounter = c
    return (c, ct)
  }

  /// Takes one inbox update: opens each new message once, in counter order; refuses replays and anything that
  /// doesn't open; says what to acknowledge.
  public mutating func take(_ r: InboxResult) -> InboxOutcome {
    var out = InboxOutcome()
    guard r.ok else {
      out.status = isRevocation(r.code) ? .revoked : .sessionEnded
      return out
    }
    out.macLastSeen = r.macLastSeen.map { Int64($0) }
    var top: UInt64 = 0
    for m in (r.messages ?? []).sorted(by: { $0.counter < $1.counter }) {
      guard m.counter >= 1, m.counter.rounded() == m.counter, m.counter <= Double(Remote.maxCounter) else { continue }
      let c = UInt64(m.counter)
      top = max(top, c)
      if c <= recv.highWater { continue }  // already handled, or a replay: never handled twice
      guard let pt = try? RemoteProtocol.open(key: keys.m2d, dir: .m2d, macId: mac.macId, deviceId: mac.deviceId, counter: c, ciphertext: m.ciphertext),
        let env = try? Envelope.parse(pt)
      else {
        out.refused.append(c)
        continue
      }
      _ = recv.accept(c)
      out.messages.append(Inbound.from(env))
    }
    if top > 0 { out.ackUpTo = top }
    return out
  }
}
