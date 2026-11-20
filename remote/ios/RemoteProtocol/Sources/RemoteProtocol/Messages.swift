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
  /// Minor 1: the step in progress, sub-agents running, steps this turn, when the turn started.
  public var step: String?
  public var agents: Int?
  public var steps: Int?
  public var turnStarted: Double?

  public init(id: String, title: String, project: String, cli: Cli, state: String, model: String = "", lastActivity: Double = 0, chat: Bool, step: String? = nil, agents: Int? = nil, steps: Int? = nil, turnStarted: Double? = nil) {
    self.id = id
    self.title = title
    self.project = project
    self.cli = cli
    self.state = state
    self.model = model
    self.lastActivity = lastActivity
    self.chat = chat
    self.step = step
    self.agents = agents
    self.steps = steps
    self.turnStarted = turnStarted
  }
}

public struct Question: Codable, Equatable, Sendable {
  public var question: String
  public var options: [String]
  public var multi: Bool
  public var allowOther: Bool
  public init(question: String, options: [String], multi: Bool, allowOther: Bool) {
    self.question = question
    self.options = options
    self.multi = multi
    self.allowOther = allowOther
  }
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
  /// Minor 1: the Mac page's first line, an edit's change, a plan's Markdown, the AI read.
  public var what: String?
  public var diff: Diff?
  public var plan: String?
  public var read: AiRead?

  public init(id: String, session: String, kind: String, tool: String, summary: String, command: String? = nil, questions: [Question] = [], explanation: String? = nil, risk: String? = nil, what: String? = nil, diff: Diff? = nil, plan: String? = nil, read: AiRead? = nil) {
    self.what = what
    self.diff = diff
    self.plan = plan
    self.read = read
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
    what = try c.decodeIfPresent(String.self, forKey: .what)
    diff = try? c.decodeIfPresent(Diff.self, forKey: .diff)
    plan = try c.decodeIfPresent(String.self, forKey: .plan)
    read = try? c.decodeIfPresent(AiRead.self, forKey: .read)
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
  /// Minor 1: the model a `start` used; the upload an `upload`'s last part finished.
  public var model: String?
  public var upload: String?
  /// Minor 2, a `transcribe`'s answer: the text (cleaned and corrected as the Mac's own dictation is), and what was
  /// heard: "words", "silence", "unclear" or "echo".
  public var text: String?
  public var heard: String?
  /// Minor 2, a `send` that went in as a note: its id (for `note` cancel / now).
  public var note: String?
  public init(of: String, t: String, ok: Bool, error: String? = nil, session: String? = nil, mode: String? = nil, model: String? = nil, upload: String? = nil, text: String? = nil, heard: String? = nil, note: String? = nil) {
    self.text = text
    self.heard = heard
    self.note = note
    self.model = model
    self.upload = upload
    self.of = of
    self.t = t
    self.ok = ok
    self.error = error
    self.session = session
    self.mode = mode
  }
}

/// A message from the Mac, typed. Unknown types are ignored (`unknown`), so the Mac can be newer.
public enum Inbound: Equatable, Sendable {
  case snapshot(sessions: [SessionInfo], needs: [Need], minor: Int = 0)
  case session(SessionInfo)
  case sessionGone(String)
  case need(Need)
  case needGone(String)
  case chatTail(session: String, items: [ChatItem])
  case result(CommandResult)
  case projects([Project])
  /// Minor 1.
  case chat(ChatUpdate)
  case overview(Overview)
  case options(StartOptions)
  case image(ImageChunk)
  case frame(Frame)
  case unknown(String)
  /// A known type whose body this version can't read: ignored as well, but worth a log line.
  case malformed(String)

  private struct Snap: Decodable { var sessions: [SessionInfo]; var needs: [Need]?; var minor: Int? }
  private struct Tail: Decodable { var session: String; var items: [ChatItem] }
  private struct Projects: Decodable { var projects: [Project] }

  public static func from(_ e: Envelope) -> Inbound {
    do {
      switch e.t {
      case "snapshot":
        let s = try e.b.decode(Snap.self)
        return .snapshot(sessions: s.sessions, needs: s.needs ?? [], minor: s.minor ?? 0)
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
      case "chat": return .chat(try e.b.decode(ChatUpdate.self))
      case "overview": return .overview(try e.b.decode(Overview.self))
      case "options": return .options(try e.b.decode(StartOptions.self))
      case "image": return .image(try e.b.decode(ImageChunk.self))
      case "frame": return .frame(try e.b.decode(Frame.self))
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
  /// Minor 1, a plan only: don't approve; keep planning, with an optional note.
  case keepPlanning(note: String?)
}

public enum NoteAction: String, Sendable, Equatable { case cancel, now }

public enum Command: Equatable, Sendable {
  case hello(name: String)
  case getSnapshot
  case getChat(session: String, n: Int = 30)
  case answer(need: String, Choice)
  /// `when` and `attachments` (upload ids) are minor 1; left out of the body at their defaults.
  case send(session: String, text: String, when: Delivery = .send, attachments: [String] = [])
  case stop(session: String)
  /// Only a project from the Mac's own list (`projects`): the phone never names a path. `model` and `mode` (minor 1)
  /// come from the Mac's `options`; the Mac refuses anything else.
  case start(Project, Cli, text: String, model: String? = nil, mode: String? = nil, attachments: [String] = [])
  /// Minor 1: a chat's live view while it is on screen (renew within 30 s); `reset` asks for all of it again.
  case watch(session: String, reset: Bool = false)
  case unwatch
  /// Minor 1: pictures of a device panel the chat's agent uses, view only. There is no input to send.
  case watchDevice(session: String, device: String)
  case unwatchDevice
  case getImage(session: String, key: String)
  /// One part of an image (see `uploadParts`); minor 2: of a file or a recording too.
  case upload(JSONValue)
  /// Minor 2: a queued steering note of a chat: withdraw it (`cancel`) or deliver it now, interrupting the step
  /// (`now`), as the Mac's strip does. Only notes the Mac lists for that chat.
  case note(session: String, note: String, action: NoteAction)
  /// Minor 2: switch a chat's model (one the Mac offers for it). There is no mode to change.
  case setModel(session: String, model: String)
  /// Minor 2: transcribe a recording sent first with `upload` (kind audio), through the Mac's own dictation.
  case transcribe(upload: String, session: String?)

  public var type: String {
    switch self {
    case .hello: "hello"
    case .getSnapshot: "get_snapshot"
    case .getChat: "get_chat"
    case .answer: "answer"
    case .send: "send"
    case .stop: "stop"
    case .start: "start"
    case .watch: "watch"
    case .unwatch: "unwatch"
    case .watchDevice: "watch_device"
    case .unwatchDevice: "unwatch_device"
    case .getImage: "get_image"
    case .upload: "upload"
    case .note: "note"
    case .setModel: "set_model"
    case .transcribe: "transcribe"
    }
  }

  public var body: JSONValue {
    switch self {
    case .hello(let name): ["name": .string(name), "minor": .number(Double(Remote.minor))]
    case .getSnapshot: [:]
    case .getChat(let s, let n): ["session": .string(s), "n": .number(Double(n))]
    case .answer(let need, let c):
      switch c {
      case .allowOnce: ["need": .string(need), "choice": "allow_once"]
      case .deny: ["need": .string(need), "choice": "deny"]
      case .option(let o): ["need": .string(need), "choice": "option", "option": .string(o)]
      case .answers(let a): ["need": .string(need), "choice": "answers", "answers": .array(a.map { .array($0.map(JSONValue.string)) })]
      case .keepPlanning(let note):
        if let n = note, !n.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          ["need": .string(need), "choice": "keep_planning", "note": .string(n)]
        } else {
          ["need": .string(need), "choice": "keep_planning"]
        }
      }
    case .send(let s, let text, let when, let atts):
      Self.object(["session": .string(s), "text": .string(text)], when == .send ? nil : ("when", .string(when.rawValue)), atts.isEmpty ? nil : ("attachments", .array(atts.map(JSONValue.string))))
    case .stop(let s): ["session": .string(s)]
    case .start(let p, let cli, let text, let model, let mode, let atts):
      Self.object(["project": .string(p.id), "cli": .string(cli.rawValue), "text": .string(text)], model.map { ("model", .string($0)) }, mode.map { ("mode", .string($0)) }, atts.isEmpty ? nil : ("attachments", .array(atts.map(JSONValue.string))))
    case .watch(let s, let reset): reset ? ["session": .string(s), "reset": true] : ["session": .string(s)]
    case .unwatch, .unwatchDevice: [:]
    case .watchDevice(let s, let d): ["session": .string(s), "device": .string(d)]
    case .getImage(let s, let k): ["session": .string(s), "key": .string(k)]
    case .upload(let b): b
    case .note(let s, let n, let a): ["session": .string(s), "note": .string(n), "do": .string(a.rawValue)]
    case .setModel(let s, let m): ["session": .string(s), "model": .string(m)]
    case .transcribe(let u, let s): Self.object(["upload": .string(u)], s.map { ("session", .string($0)) })
    }
  }

  private static func object(_ base: [String: JSONValue], _ extra: (String, JSONValue)?...) -> JSONValue {
    var o = base
    for case let (k, v)? in extra { o[k] = v }
    return .object(o)
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
