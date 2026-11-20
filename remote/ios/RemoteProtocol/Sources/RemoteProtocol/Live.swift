// Minor 1 of the protocol (docs/REMOTE.md "Minor 1"): a chat's live view, Mission control for the phone, the options
// a new chat can start with, images both ways in chunks, device frames. Mirrors crates/remote/src/live.rs and
// remote/phone/src/protocol.mjs. Still no I/O.

import Foundation

extension Remote {
  /// Said in `hello`; the envelope's `v` stays 1, so an older Mac takes the messages it knows and ignores the rest.
  public static let minor = 1
  /// Raw bytes per image chunk, both ways.
  public static let chunk = 48 * 1024
  /// Largest image the phone may send (the app scales down first).
  public static let maxUpload = 2_000_000
  /// Images per message.
  public static let maxAttach = 4
}

/// An image as `upload` bodies: `{upload, part, parts, size, data}`, data the part's bytes in base64url.
public func uploadParts(id: String, _ data: Data) -> [JSONValue] {
  let parts = max(1, (data.count + Remote.chunk - 1) / Remote.chunk)
  return (0..<parts).map { i in
    let lo = data.startIndex + i * Remote.chunk
    let hi = min(lo + Remote.chunk, data.endIndex)
    return ["upload": .string(id), "part": .number(Double(i)), "parts": .number(Double(parts)), "size": .number(Double(data.count)), "data": .string(B64U.encode(data[lo..<hi]))]
  }
}

/// What the phone accepts as an image to send, by its bytes: PNG, JPEG, GIF, WebP (as the Mac checks).
public func imageType(_ d: Data) -> String? {
  let b = [UInt8](d.prefix(12))
  if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
  if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
  if b.starts(with: Array("GIF87a".utf8)) || b.starts(with: Array("GIF89a".utf8)) { return "image/gif" }
  if b.count >= 12, b[0..<4].elementsEqual(Array("RIFF".utf8)), b[8..<12].elementsEqual(Array("WEBP".utf8)) { return "image/webp" }
  return nil
}

/// Puts an image's chunks back together (the Mac's `image` messages), per key.
public struct ChunkJoin: Sendable {
  var parts: [String: [Int: Data]] = [:]
  public init() {}

  /// Takes one chunk; returns the whole image once every part is there.
  public mutating func take(key: String, part: Int, parts n: Int, size: Int, data: String) -> Data? {
    guard n >= 1, n <= 64, part >= 0, part < n, size <= 4_000_000, let d = try? B64U.decode(data) else { return nil }
    parts[key, default: [:]][part] = d
    guard let got = parts[key], got.count == n else { return nil }
    let whole = (0..<n).compactMap { got[$0] }.reduce(Data(), +)
    parts[key] = nil
    return whole.count == size ? whole : nil
  }
}

// ---------------------------------------------------------------- what the Mac sends (minor 1)

/// A change to one file: an Edit's old and new text, or a new file's text (`before` empty).
public struct Diff: Codable, Equatable, Sendable {
  public var path: String
  public var before: String
  public var after: String
  public var cut: Bool?
  public init(path: String, before: String, after: String, cut: Bool? = nil) {
    self.path = path
    self.before = before
    self.after = after
    self.cut = cut
  }
}

/// The AI read the Mac's Needs-you page shows for a request.
public struct AiRead: Codable, Equatable, Sendable {
  public var what: String
  public var why: String
  public var check: [String]
  public init(what: String, why: String, check: [String] = []) {
    self.what = what
    self.why = why
    self.check = check
  }
}

public struct ImageRef: Codable, Equatable, Sendable, Hashable {
  public var key: String
  public var name: String?
  public init(key: String, name: String? = nil) {
    self.key = key
    self.name = name
  }
}

/// One item of a chat's live view, upserted by `k`: role "user", "assistant", "tool", "agent" (a sub-agent) or "notice".
public struct LiveItem: Codable, Equatable, Sendable, Identifiable {
  public var k: String
  public var role: String
  public var text: String?
  public var tool: String?
  public var ok: Bool?
  public var steps: Int?
  public var steer: Bool?
  public var diff: Diff?
  public var images: [ImageRef]?
  public var ts: Double?
  public var id: String { k }
  public init(k: String, role: String, text: String? = nil, tool: String? = nil, ok: Bool? = nil, steps: Int? = nil, steer: Bool? = nil, diff: Diff? = nil, images: [ImageRef]? = nil, ts: Double? = nil) {
    self.k = k
    self.role = role
    self.text = text
    self.tool = tool
    self.ok = ok
    self.steps = steps
    self.steer = steer
    self.diff = diff
    self.images = images
    self.ts = ts
  }
}

public struct LiveAgent: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var label: String
  public var steps: Int
  public var step: String?
  public var done: Bool
  public init(id: String, label: String, steps: Int = 0, step: String? = nil, done: Bool = false) {
    self.id = id
    self.label = label
    self.steps = steps
    self.step = step
    self.done = done
  }
}

public struct Tally: Codable, Equatable, Sendable {
  public var steps: Int
  public var edits: Int
  public var since: Double?
  public init(steps: Int = 0, edits: Int = 0, since: Double? = nil) {
    self.steps = steps
    self.edits = edits
    self.since = since
  }
}

/// What happens in a chat now: its state, the text streaming in, the step, sub-agents, the turn's tally, the device
/// panels its agent uses.
public struct ChatLive: Codable, Equatable, Sendable {
  public var state: String?
  public var text: String?
  public var thinking: Bool?
  public var step: String?
  public var agents: [LiveAgent]?
  public var tally: Tally?
  public var devices: [String]?
  public init(state: String? = nil, text: String? = nil, thinking: Bool? = nil, step: String? = nil, agents: [LiveAgent]? = nil, tally: Tally? = nil, devices: [String]? = nil) {
    self.state = state
    self.text = text
    self.thinking = thinking
    self.step = step
    self.agents = agents
    self.tally = tally
    self.devices = devices
  }
}

/// A `chat` message: the whole view (`reset`) or the items changed since the last one; `live` on the last of a group.
public struct ChatUpdate: Codable, Equatable, Sendable {
  public var session: String
  public var items: [LiveItem]
  public var cursor: Double?
  public var reset: Bool?
  public var more: Bool?
  public var live: ChatLive?
  public init(session: String, items: [LiveItem], cursor: Double? = nil, reset: Bool? = nil, more: Bool? = nil, live: ChatLive? = nil) {
    self.session = session
    self.items = items
    self.cursor = cursor
    self.reset = reset
    self.more = more
    self.live = live
  }
}

/// Mission control for the phone.
public struct Overview: Codable, Equatable, Sendable {
  public struct Change: Codable, Equatable, Sendable, Hashable {
    public var session: String
    public var kind: String
    public var action: String
    public var object: String
    public var times: Int?
    public var ts: Double
    public init(session: String, kind: String, action: String, object: String, times: Int? = nil, ts: Double) {
      self.session = session
      self.kind = kind
      self.action = action
      self.object = object
      self.times = times
      self.ts = ts
    }
  }
  public struct Commit: Codable, Equatable, Sendable, Hashable {
    public var short: String
    public var subject: String
    public var ts: Double
    public var files: Int?
    public var merge: Bool?
    public init(short: String, subject: String, ts: Double, files: Int? = nil, merge: Bool? = nil) {
      self.short = short
      self.subject = subject
      self.ts = ts
      self.files = files
      self.merge = merge
    }
  }
  public struct Overlap: Codable, Equatable, Sendable, Hashable {
    public var file: String
    public var sessions: [String]
    public var titles: [String]?
    public var ts: Double
    public init(file: String, sessions: [String], titles: [String]? = nil, ts: Double) {
      self.file = file
      self.sessions = sessions
      self.titles = titles
      self.ts = ts
    }
  }
  public struct AgentRow: Codable, Equatable, Sendable, Hashable {
    public var label: String
    public var step: String?
    public init(label: String, step: String? = nil) {
      self.label = label
      self.step = step
    }
  }
  public struct SessionAgents: Codable, Equatable, Sendable, Hashable {
    public var session: String
    public var agents: [AgentRow]
    public init(session: String, agents: [AgentRow]) {
      self.session = session
      self.agents = agents
    }
  }
  public struct ProjectView: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var working: Int?
    public var needs: Int?
    public var idle: Int?
    public var sessions: [String]?
    public var agents: [SessionAgents]?
    public var changes: [Change]?
    public var overlaps: [Overlap]?
    public var commits: [Commit]?
    public var branch: String?
    public var id: String { name }
    public init(name: String, working: Int? = nil, needs: Int? = nil, idle: Int? = nil, sessions: [String]? = nil, agents: [SessionAgents]? = nil, changes: [Change]? = nil, overlaps: [Overlap]? = nil, commits: [Commit]? = nil, branch: String? = nil) {
      self.name = name
      self.working = working
      self.needs = needs
      self.idle = idle
      self.sessions = sessions
      self.agents = agents
      self.changes = changes
      self.overlaps = overlaps
      self.commits = commits
      self.branch = branch
    }
  }
  public struct Window: Codable, Equatable, Sendable, Hashable {
    public var label: String
    public var kind: String?
    public var percent: Double?
    public var resets: Double?
    public init(label: String, kind: String? = nil, percent: Double? = nil, resets: Double? = nil) {
      self.label = label
      self.kind = kind
      self.percent = percent
      self.resets = resets
    }
  }
  public struct Usage: Codable, Equatable, Sendable {
    public var plan: String?
    public var stale: Bool?
    public var windows: [Window]
    public init(plan: String? = nil, stale: Bool? = nil, windows: [Window] = []) {
      self.plan = plan
      self.stale = stale
      self.windows = windows
    }
  }
  public var projects: [ProjectView]
  public var usage: [String: Usage]?
  public init(projects: [ProjectView] = [], usage: [String: Usage]? = nil) {
    self.projects = projects
    self.usage = usage
  }

  private enum CodingKeys: String, CodingKey { case projects, usage }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    projects = try c.decodeIfPresent([ProjectView].self, forKey: .projects) ?? []
    // A provider with no data is `null`: left out.
    let raw = try c.decodeIfPresent([String: Usage?].self, forKey: .usage)
    usage = raw?.compactMapValues { $0 }
  }
}

/// What a new chat can start with, per CLI: the Mac's models and the modes a phone may use (never Bypass / full access).
public struct StartOptions: Codable, Equatable, Sendable {
  public struct Choice: Codable, Equatable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public init(id: String, label: String) {
      self.id = id
      self.label = label
    }
  }
  public struct PerCli: Codable, Equatable, Sendable {
    public var models: [Choice]
    public var modes: [Choice]
    public var model: String?
    public var mode: String?
    public init(models: [Choice] = [], modes: [Choice] = [], model: String? = nil, mode: String? = nil) {
      self.models = models
      self.modes = modes
      self.model = model
      self.mode = mode
    }
  }
  public var claude: PerCli?
  public var codex: PerCli?
  public init(claude: PerCli? = nil, codex: PerCli? = nil) {
    self.claude = claude
    self.codex = codex
  }
  public subscript(cli: Cli) -> PerCli? { cli == .claude ? claude : codex }
}

/// One chunk of an image of a chat.
public struct ImageChunk: Codable, Equatable, Sendable {
  public var session: String
  public var key: String
  public var part: Int
  public var parts: Int
  public var size: Int
  public var data: String
}

/// One picture of a device panel (view only), or why there is none.
public struct Frame: Codable, Equatable, Sendable {
  public var session: String
  public var device: String
  public var seq: Int?
  public var data: String?
  public var error: String?
  public init(session: String, device: String, seq: Int? = nil, data: String? = nil, error: String? = nil) {
    self.session = session
    self.device = device
    self.seq = seq
    self.data = data
    self.error = error
  }
}

/// How a message goes into a running chat (`send`'s `when`), as the Mac's composer does.
public enum Delivery: String, Sendable, Equatable {
  /// A message (queued for the next turn if the agent is working).
  case send
  /// A note the agent takes in at its next step.
  case next
  /// Interrupts the step in progress and sends.
  case interrupt
}

/// A chat's items, kept by key: a `chat` message upserts them in order.
public struct LiveLog: Equatable, Sendable {
  public private(set) var items: [LiveItem] = []
  public var live: ChatLive?
  public var cursor: Double?
  public init() {}

  public mutating func apply(_ u: ChatUpdate) {
    if u.reset == true { items = [] }
    for it in u.items {
      if let i = items.firstIndex(where: { $0.k == it.k }) { items[i] = it } else { items.append(it) }
    }
    if let l = u.live { live = l }
    if let c = u.cursor { cursor = c }
    if items.count > 300 { items.removeFirst(items.count - 300) }
  }
}
