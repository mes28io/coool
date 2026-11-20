// The app's state: the pairing, the link to the Mac through the relay, and what the Mac last said (sessions,
// needs, projects, chat tails). Mirrors remote/phone/src/phone.mjs. Everything here runs on the main actor; the
// relay calls are async.

import AudioToolbox
import Combine
import ConvexMobile
import Foundation
import Observation
import RemoteProtocol
import UIKit

@MainActor
@Observable
final class RemoteStore {
  enum Phase: Equatable { case unpaired, claiming, paired }
  enum ClaimState: Equatable {
    case sending
    case waiting(code: String)
    case refused
    case expired
    case failed(String)
  }

  var phase: Phase = .unpaired
  var claimState: ClaimState?
  /// Shown on the pairing screen after the Mac removed this phone.
  var revokedNotice: String?
  var pairError: String?

  var mac: PairedMac?
  var sessions: [String: SessionInfo] = [:]
  var needs: [Need] = []
  var projects: [Project] = []
  var tails: [String: [ChatItem]] = [:]
  /// The mode the Mac started a chat in, for chats this phone started.
  var startedMode: [String: String] = [:]
  /// A chat started from here is `chat:<n>` at first, then listed under its CLI's id: the later id, by the first.
  var alias: [String: String] = [:]
  var macLastSeen: Int64?
  /// Subscribed, and the relay has answered.
  var live = false
  var connError: String?
  /// Needs that arrived and haven't been opened: the in-app badge.
  var unseen: Set<String> = []
  /// A demo store (screenshots, previews): commands answer at once, nothing reaches a relay.
  var demo = false

  @ObservationIgnored private var relay: RelayClient?
  @ObservationIgnored private var link: Link?
  @ObservationIgnored private var sub: AnyCancellable?
  @ObservationIgnored private var waiters: [String: CheckedContinuation<CommandResult?, Never>] = [:]
  @ObservationIgnored private var results: [String: CommandResult] = [:]
  @ObservationIgnored private var connecting = false
  @ObservationIgnored private var active = false
  @ObservationIgnored private var retryDelay: Double = 2
  @ObservationIgnored private var claimTask: Task<Void, Never>?
  @ObservationIgnored private var knownNeeds: Set<String> = []
  @ObservationIgnored private var pendingStarts: [String: (project: String, cli: Cli, at: Date)] = [:]

  init() {
    if let m = Vault.load(), let l = try? Link(m, recvHighWater: Vault.recvHighWater, sendCounter: Vault.sendCounter) {
      mac = m
      link = l
      phase = .paired
    }
  }

  // ---------------------------------------------------------------- derived

  /// The Mac is online if the relay saw it in the last two and a half minutes (it checks in every minute).
  func macOnline(now: Date = Date()) -> Bool {
    guard let s = macLastSeen else { return false }
    return Int64(now.timeIntervalSince1970 * 1000) - s < 150_000
  }

  func need(for session: String) -> Need? {
    let other = alias[session]
    return needs.first { $0.session == session || $0.session == other }
  }

  /// The session a chat view shows: the started chat under its later id, once the Mac lists it.
  func session(_ id: String) -> SessionInfo? { alias[id].flatMap { sessions[$0] } ?? sessions[id] }

  func started(_ session: String, project: String, cli: Cli, mode: String) {
    startedMode[session] = mode
    pendingStarts[session] = (project, cli, Date())
  }

  func status(of s: SessionInfo) -> Status { Status(s, hasNeed: need(for: s.id) != nil) }

  /// Sessions grouped by project: projects with a need first, then by latest activity.
  var groups: [(project: String, sessions: [SessionInfo])] {
    let by = Dictionary(grouping: sessions.values, by: \.project)
    return by.map { (project: $0.key, sessions: $0.value.sorted { $0.lastActivity > $1.lastActivity }) }
      .sorted { a, b in
        let na = a.sessions.contains { need(for: $0.id) != nil }, nb = b.sessions.contains { need(for: $0.id) != nil }
        if na != nb { return na }
        return (a.sessions.first?.lastActivity ?? 0) > (b.sessions.first?.lastActivity ?? 0)
      }
  }

  // ---------------------------------------------------------------- pairing

  func pair(text: String, name: String) {
    pairError = nil
    let link: PairLink
    do {
      link = try PairLink.parse(text)
    } catch {
      pairError = Self.describe(error)
      return
    }
    let deviceName = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "iPhone" : name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pending = try? PendingClaim(link: link, name: String(deviceName.prefix(60))) else {
      pairError = "That pairing code can't be read. Make a new one on your Mac."
      return
    }
    claimTask?.cancel()
    phase = .claiming
    claimState = .sending
    revokedNotice = nil
    claimTask = Task { await self.claim(pending) }
  }

  private func claim(_ p: PendingClaim) async {
    let relay = RelayClient(url: p.link.relay)
    do {
      let r = try await relay.claimPairing(p.paired.identity, p.claim)
      guard !Task.isCancelled else { return }
      guard r.ok else {
        claimState = .failed(Self.describeClaim(r.code))
        return
      }
      claimState = .waiting(code: p.code)
      let end = Date().addingTimeInterval(180)
      while Date() < end {
        try await Task.sleep(for: .seconds(1))
        let s = try await relay.claimStatus(p.paired.identity, pairingId: p.claim.pairingId, deviceId: p.claim.deviceId)
        guard !Task.isCancelled else { return }
        if s.ok, s.state == "paired" {
          complete(p.paired, relay)
          return
        }
        if !s.ok || s.state == "refused" {
          claimState = .refused
          return
        }
        if s.state == "expired" {
          claimState = .expired
          return
        }
      }
      claimState = .expired
    } catch is CancellationError {
    } catch {
      if !Task.isCancelled { claimState = .failed("Can't reach the relay. Check your connection and try again.") }
    }
  }

  private func complete(_ paired: PairedMac, _ relay: RelayClient) {
    Vault.forget()
    guard Vault.save(paired), let l = try? Link(paired) else {
      claimState = .failed("This iPhone couldn't store the pairing keys.")
      return
    }
    mac = paired
    link = l
    self.relay = relay
    phase = .paired
    claimState = nil
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    Task { await connect() }
  }

  func cancelClaim() {
    claimTask?.cancel()
    claimTask = nil
    claimState = nil
    phase = .unpaired
  }

  /// Forgets the Mac on this phone. (The Mac keeps listing it until it is removed there.)
  func unpair() {
    forget()
    revokedNotice = nil
  }

  private func revoked() {
    forget()
    revokedNotice = "This iPhone was removed in coool on your Mac, so it can no longer see or steer your sessions. To use Remote again, pair it once more: on the Mac, open Settings > Remote > Pair an iPhone."
  }

  private func forget() {
    disconnect()
    Vault.forget()
    mac = nil
    link = nil
    relay = nil
    sessions = [:]
    needs = []
    projects = []
    tails = [:]
    unseen = []
    knownNeeds = []
    macLastSeen = nil
    connError = nil
    for (_, w) in waiters { w.resume(returning: nil) }
    waiters = [:]
    phase = .unpaired
  }

  // ---------------------------------------------------------------- the link

  /// The app came to the foreground (true) or left it (false). The link is open only while the app is in use.
  func setActive(_ on: Bool) {
    active = on
    if on {
      Task { await connect() }
    } else {
      disconnect()
      relay = nil  // closes the WebSocket
    }
  }

  func connect() async {
    guard !demo, active, phase == .paired, let mac, sub == nil, !connecting else { return }
    connecting = true
    defer { connecting = false }
    let relay = self.relay ?? RelayClient(url: mac.relay)
    self.relay = relay
    do {
      let (token, answer) = try await relay.openSession(mac)
      guard let token else {
        if isRevocation(answer.code) { revoked() } else { connError = Self.describeRelay(answer.code); retryLater() }
        return
      }
      sub = relay.inbox(token: token)
        .receive(on: DispatchQueue.main)
        .sink(receiveCompletion: { [weak self] _ in
          MainActor.assumeIsolated {
            self?.sub = nil
            self?.live = false
            self?.retryLater()
          }
        }, receiveValue: { [weak self] r in
          MainActor.assumeIsolated { self?.take(r) }
        })
      _ = try? await send(.hello(name: mac.name))
    } catch {
      connError = "Can't reach the relay."
      retryLater()
    }
  }

  private func disconnect() {
    sub?.cancel()
    sub = nil
    live = false
  }

  private func retryLater() {
    guard active, phase == .paired else { return }
    let d = retryDelay
    retryDelay = min(retryDelay * 2, 30)
    Task {
      try? await Task.sleep(for: .seconds(d))
      await connect()
    }
  }

  private func take(_ r: InboxResult) {
    guard var l = link, let mac else { return }
    let out = l.take(r)
    link = l
    Vault.recvHighWater = l.recv.highWater
    switch out.status {
    case .revoked:
      revoked()
      return
    case .sessionEnded:
      // Expired, or deleted because the Mac removed this phone: reopening says which.
      disconnect()
      Task { await connect() }
      return
    case .ok: break
    }
    live = true
    connError = nil
    retryDelay = 2
    if let s = out.macLastSeen { macLastSeen = s }
    for m in out.messages { apply(m) }
    if let up = out.ackUpTo, let relay {
      Task { _ = try? await relay.ack(mac, upTo: up) }
    }
  }

  func apply(_ m: Inbound) {
    switch m {
    case .snapshot(let ss, let ns):
      sessions = Dictionary(ss.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
      let ids = Set(ns.map(\.id))
      unseen.formIntersection(ids)
      needs = ns
      arrived(ns)
    case .session(let s):
      if sessions[s.id] == nil, s.chat, !s.id.hasPrefix("chat:"),
        let k = pendingStarts.first(where: { $0.value.project == s.project && $0.value.cli == s.cli && Date().timeIntervalSince($0.value.at) < 120 })?.key {
        alias[k] = s.id
        pendingStarts[k] = nil
      }
      sessions[s.id] = s
    case .sessionGone(let id): sessions[id] = nil
    case .need(let n):
      if let i = needs.firstIndex(where: { $0.id == n.id }) { needs[i] = n } else { needs.append(n) }
      arrived([n])
    case .needGone(let id):
      needs.removeAll { $0.id == id }
      unseen.remove(id)
    case .chatTail(let s, let items): tails[s] = items
    case .result(let r):
      results[r.of] = r
      if let w = waiters.removeValue(forKey: r.of) { w.resume(returning: r) }
    case .projects(let p): projects = p
    case .unknown, .malformed: break  // either side can be newer
    }
  }

  /// A need that wasn't here before: the in-app badge, and the haptic / sound if they're on.
  private func arrived(_ ns: [Need]) {
    let new = ns.filter { !knownNeeds.contains($0.id) }
    guard !new.isEmpty else { return }
    knownNeeds.formUnion(new.map(\.id))
    unseen.formUnion(new.map(\.id))
    let d = UserDefaults.standard
    if d.object(forKey: "haptics") as? Bool ?? true { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    if d.bool(forKey: "sound") { AudioServicesPlaySystemSound(1007) }
  }

  func markSeen(_ need: String) { unseen.remove(need) }

  // ---------------------------------------------------------------- commands

  enum SendError: LocalizedError {
    case notConnected
    case refused(String)
    var errorDescription: String? {
      switch self {
      case .notConnected: "Not connected to the relay."
      case .refused(let c): RemoteStore.describeRelay(c)
      }
    }
  }

  /// Seals and sends one command; returns its envelope id.
  @discardableResult
  func send(_ cmd: Command) async throws -> String {
    guard var l = link, let mac else { throw SendError.notConnected }
    let relay = self.relay ?? RelayClient(url: mac.relay)
    self.relay = relay
    let env = cmd.envelope()
    let (counter, ct) = try l.seal(env)
    link = l
    Vault.sendCounter = counter
    let r = try await relay.send(mac, counter: counter, ciphertext: ct)
    if !r.ok {
      if isRevocation(r.code) { revoked() }
      throw SendError.refused(r.code ?? "unknown")
    }
    return env.id
  }

  /// Sends a command and waits for the Mac's `result` (nil if none came: the Mac is offline or dropped it).
  func perform(_ cmd: Command, timeout: Double = 30) async -> Result<CommandResult, Error> {
    if demo { return .success(CommandResult(of: "demo", t: cmd.type, ok: true, session: "chat:9", mode: "default")) }
    do {
      let id = try await send(cmd)
      if let r = results.removeValue(forKey: id) { return .success(r) }
      let r: CommandResult? = await withCheckedContinuation { c in
        waiters[id] = c
        Task {
          try? await Task.sleep(for: .seconds(timeout))
          if let w = self.waiters.removeValue(forKey: id) { w.resume(returning: nil) }
        }
      }
      guard let r else { return .failure(PerformError.noAnswer) }
      return .success(r)
    } catch {
      return .failure(error)
    }
  }

  enum PerformError: LocalizedError {
    case noAnswer
    var errorDescription: String? { "Your Mac didn't answer. It may be asleep, or coool isn't running." }
  }

  func requestTail(_ session: String) async {
    guard !demo else { return }
    _ = try? await send(.getChat(session: session, n: 40))
  }

  func refresh() async {
    guard !demo else { return }
    _ = try? await send(.getSnapshot)
  }

  // ---------------------------------------------------------------- words

  static func describe(_ e: Error) -> String {
    switch e as? ProtocolError {
    case .notPairingLink: "That isn't a coool pairing code. It starts with coool://pair."
    case .wrongVersion: "That pairing code is from a different version of coool. Update both apps."
    case .badRelayAddress: "That pairing code names a relay this app won't use."
    default: "That pairing code can't be read. Make a new one on your Mac."
    }
  }

  static func describeClaim(_ code: String?) -> String {
    switch code {
    case "expired", "unknown_pairing": "That code has expired or was already used. Make a new one on your Mac."
    case "used", "claimed": "That code was already used. Make a new one on your Mac."
    case "rate_limited": "Too many tries. Wait a minute and make a new code on your Mac."
    default: "The relay refused this pairing (\(code ?? "unknown")). Make a new code on your Mac."
    }
  }

  nonisolated static func describeRelay(_ code: String?) -> String {
    switch code {
    case "rate_limited": "Too many requests for now. Try again in a minute."
    case "revoked": "This iPhone was removed on your Mac."
    default: "The relay refused the request (\(code ?? "unknown"))."
    }
  }
}
