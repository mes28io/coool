// The app's state: the pairing, the link to the Mac through the relay, and what the Mac last said (sessions,
// needs, projects, chat tails). Mirrors remote/phone/src/phone.mjs. Everything here runs on the main actor; the
// relay calls are async.

import AudioToolbox
import Combine
import ConvexMobile
import Foundation
import Observation
import RemoteProtocol
import SwiftUI
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

  // Minor 1 (docs/REMOTE.md "Minor 1"): what a newer Mac also sends.
  /// Each watched chat's live items, by session.
  var logs: [String: LiveLog] = [:]
  var overview: Overview?
  var options: StartOptions?
  /// The Mac speaks minor 1 (it sent an overview, options or a live chat).
  var macMinor = 0
  /// Images of chats, by key, as they arrive; the newest device frame per session and panel.
  var images: [String: UIImage] = [:]
  var frames: [String: (image: UIImage, seq: Int, at: Date)] = [:]
  var frameErrors: [String: String] = [:]
  // Minor 2 and the feel of sending (Outbox.swift).
  /// Per chat (its live id), what was sent from here and hasn't settled into the chat yet.
  var outbox: [String: [Outgoing]] = [:]
  /// Row identities: an item that is the Mac's copy of an outgoing message keeps that message's row (it settles in
  /// place), and a reply that ends a stream keeps the stream's row (the text doesn't jump).
  var rowIds: [String: String] = [:]
  /// Per chat, the row id of the reply streaming in now.
  var streamIds: [String: String] = [:]
  @ObservationIgnored private var streamSeq = 0
  /// When each item key was first seen here (for the live view's entrance animation).
  @ObservationIgnored private var imageJoin = ChunkJoin()
  @ObservationIgnored private var askedImages: Set<String> = []
  @ObservationIgnored private var uploadWaiters: [String: CheckedContinuation<CommandResult?, Never>] = [:]
  @ObservationIgnored private var uploadOf: [String: String] = [:]

  @ObservationIgnored private var relay: RelayClient?
  @ObservationIgnored private var link: RemoteProtocol.Link?
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
    if let m = Vault.load(), let l = try? RemoteProtocol.Link(m, recvHighWater: Vault.recvHighWater, sendCounter: Vault.sendCounter) {
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
    guard Vault.save(paired), let l = try? RemoteProtocol.Link(paired) else {
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
    logs = [:]
    outbox = [:]
    rowIds = [:]
    streamIds = [:]
    overview = nil
    options = nil
    macMinor = 0
    images = [:]
    frames = [:]
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
    guard !demo else { return }  // invented data: there is no link to open or close
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
    case .snapshot(let ss, let ns, let minor):
      macMinor = max(macMinor, minor)
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
      if let up = uploadOf.removeValue(forKey: r.of), let w = uploadWaiters.removeValue(forKey: up) { w.resume(returning: r) }
    case .projects(let p): projects = p
    case .chat(let u):
      macMinor = max(macMinor, 1)
      took(u)
    case .overview(let o):
      macMinor = max(macMinor, 1)
      withAnimation(Theme.calm) { overview = o }
    case .options(let o):
      macMinor = max(macMinor, 1)
      options = o
    case .image(let c):
      if let d = imageJoin.take(key: c.key, part: c.part, parts: c.parts, size: c.size, data: c.data), let img = UIImage(data: d) { images[c.key] = img }
    case .frame(let f):
      let k = "\(f.session)|\(f.device)"
      if let e = f.error { frameErrors[k] = e }
      if let b = f.data, let d = try? B64U.decode(b), imageType(d) != nil, let img = UIImage(data: d) {
        frameErrors[k] = nil
        frames[k] = (img, f.seq ?? 0, Date())
      }
    case .unknown, .malformed: break  // either side can be newer
    }
  }

  /// One `chat` message: the items upserted, the stream's row handed to the reply that ends it, and what this phone
  /// sent settled into the Mac's copies. Animated except for a whole view (a reset arrives all at once, still).
  func took(_ u: ChatUpdate) {
    let s = u.session
    let old = logs[s] ?? LiveLog()
    let before = Set(old.items.map(\.k))
    var l = old
    l.apply(u)
    let streamed = !(old.live?.text ?? "").isEmpty
    let streaming = !(l.live?.text ?? "").isEmpty
    if streamed, let a = l.items.first(where: { $0.role == "assistant" && !before.contains($0.k) }), rowIds[a.k] == nil {
      rowIds[a.k] = streamId(s)
    }
    if streamed && !streaming { nextStream(s) }
    var out = outbox[s] ?? []
    let taken = Set(rowIds.keys)
    for (o, k) in Settle.match(out.filter { !$0.isNote }, items: l.items, taken: taken) {
      rowIds[k] = o
      out.removeAll { $0.id == o }
    }
    // Notes: settled once the Mac lists them (its strip shows them from then on) or their copy arrived.
    let noted = Settle.notes(out, notes: l.live?.notes ?? [], taken: [])
    let delivered = Settle.match(out.filter(\.isNote), items: l.items.filter { $0.steer == true }, taken: taken)
    out.removeAll { noted[$0.id] != nil || delivered[$0.id] != nil }
    let quiet = u.reset == true && old.items.isEmpty
    let change = {
      self.logs[s] = l
      self.outbox[s] = out
    }
    if quiet { change() } else { withAnimation(Theme.settle) { change() } }
  }

  func streamId(_ session: String) -> String {
    if let id = streamIds[session] { return id }
    let id = "stream:\(streamSeq)"
    streamSeq += 1
    streamIds[session] = id
    return id
  }

  private func nextStream(_ session: String) { streamIds[session] = nil }

  /// The row a live item is shown in.
  func rowId(_ item: LiveItem) -> String { rowIds[item.k] ?? item.k }

  // ---------------------------------------------------------------- sending (optimistic)

  /// Sends a message or a note: it shows at once as sending, then sent, and settles into the Mac's copy.
  func submit(session: String, text: String, attachments: [Attachment], how: Delivery) {
    let known = Set((logs[session]?.items ?? []).filter { $0.role == "user" }.map(\.k))
    let o = Outgoing(id: "out:\(randomId())", session: session, text: text, attachments: attachments, how: how, known: known)
    withAnimation(Theme.settle) { outbox[session, default: []].append(o) }
    Task { await deliver(o) }
  }

  func retry(_ o: Outgoing) {
    update(o) { $0.state = .sending }
    Task { await deliver(o) }
  }

  func discard(_ o: Outgoing) {
    withAnimation(Theme.settle) { outbox[o.session]?.removeAll { $0.id == o.id } }
  }

  private func update(_ o: Outgoing, _ f: (inout Outgoing) -> Void) {
    guard var list = outbox[o.session], let i = list.firstIndex(where: { $0.id == o.id }) else { return }
    f(&list[i])
    withAnimation(Theme.settle) { outbox[o.session] = list }
  }

  private func deliver(_ o: Outgoing) async {
    var ids: [String] = []
    if !o.attachments.isEmpty {
      do { ids = try await upload(o.attachments) } catch {
        update(o) { $0.state = .failed(error.localizedDescription) }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        return
      }
    }
    let r = await perform(.send(session: o.session, text: o.text, when: o.how, attachments: ids))
    switch r {
    case .success(let res) where res.ok:
      update(o) {
        $0.state = .sent
        $0.note = res.note
      }
      if demo { demoEcho(o) }
    case .success(let res):
      update(o) { $0.state = .failed(res.error ?? "Your Mac refused it.") }
      UINotificationFeedbackGenerator().notificationOccurred(.error)
    case .failure(let e):
      update(o) { $0.state = .failed(e.localizedDescription) }
      UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
  }

  /// Demo only: the Mac's copy of a message arrives a moment later, then a reply streams in lumps as the Mac sends it.
  private func demoEcho(_ o: Outgoing) {
    #if DEBUG
      Demo.echo(self, o)
    #endif
  }

  // ---------------------------------------------------------------- notes, model, voice (minor 2)

  /// Withdraws a queued note, or delivers it now (interrupting the step), as the Mac's strip does.
  func note(_ session: String, _ id: String, _ action: NoteAction) async -> String? {
    if demo {
      if var l = logs[session], var live = l.live {
        live.notes?.removeAll { $0.id == id }
        l.live = live
        withAnimation(Theme.settle) { logs[session] = l }
      }
      return nil
    }
    switch await perform(.note(session: session, note: id, action: action)) {
    case .success(let r) where r.ok: return nil
    case .success(let r): return r.error ?? "Your Mac refused."
    case .failure(let e): return e.localizedDescription
    }
  }

  /// Switches a chat's model (the Mac checks it is one it offers for that chat).
  func setModel(_ session: String, _ model: String) async -> String? {
    if demo {
      if var l = logs[session] {
        l.meta?.model = model
        logs[session] = l
      }
      return nil
    }
    switch await perform(.setModel(session: session, model: model)) {
    case .success(let r) where r.ok: return nil
    case .success(let r): return r.error ?? "Your Mac refused."
    case .failure(let e): return e.localizedDescription
    }
  }

  enum VoiceError: LocalizedError {
    case tooLong, refused(String), noAnswer
    var errorDescription: String? {
      switch self {
      case .tooLong: "That recording is too long to send. Keep it under two minutes."
      case .refused(let e): e
      case .noAnswer: "Your Mac didn't transcribe it. It may be asleep, or coool isn't running."
      }
    }
  }

  /// Sends a recording to the Mac (encrypted, in parts) and returns the text its dictation made of it.
  func transcribe(_ audio: Data, session: String?) async throws -> (text: String, heard: String) {
    if demo { return ("Add a retry with backoff to the upload client, and log each attempt.", "words") }
    guard audio.count <= Remote.maxAudio, audioType(audio) != nil else { throw VoiceError.tooLong }
    let id = try await sendParts(audio, kind: .audio, ext: nil)
    switch await perform(.transcribe(upload: id, session: session), timeout: 120) {
    case .success(let r) where r.ok: return (r.text ?? "", r.heard ?? "words")
    case .success(let r): throw VoiceError.refused(r.error ?? "Your Mac couldn't transcribe it.")
    case .failure: throw VoiceError.noAnswer
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

  // ---------------------------------------------------------------- minor 1

  /// Keeps a chat's live view coming while `body` runs (the view is on screen): a lease renewed every 10 s. A Mac
  /// that doesn't know `watch` ignores it; then the tail is polled as before.
  func watch(_ session: String) async {
    guard !demo else { return }
    var first = true
    while !Task.isCancelled {
      _ = try? await send(.watch(session: session, reset: first && logs[session] != nil))
      first = false
      // An older Mac: no live view comes, so ask for the tail now and then.
      if macMinor == 0 { await requestTail(session) }
      try? await Task.sleep(for: .seconds(macMinor == 0 ? 4 : 10))
    }
    _ = try? await send(.unwatch)
  }

  /// Device frames for one panel while its view is open (a lease renewed every 10 s; the Mac sends one every 2.5 s at most).
  func watchDevice(_ session: String, _ device: String) async {
    guard !demo else { return }
    while !Task.isCancelled {
      _ = try? await send(.watchDevice(session: session, device: device))
      try? await Task.sleep(for: .seconds(10))
    }
    _ = try? await send(.unwatchDevice)
  }

  func frame(_ session: String, _ device: String) -> (image: UIImage, seq: Int, at: Date)? { frames["\(session)|\(device)"] }
  func frameError(_ session: String, _ device: String) -> String? { frameErrors["\(session)|\(device)"] }

  /// Asks the Mac once for an image of a chat (an attachment, by its key).
  func wantImage(_ session: String, _ key: String) {
    guard !demo, images[key] == nil, !askedImages.contains(key) else { return }
    askedImages.insert(key)
    Task { _ = try? await send(.getImage(session: session, key: key)) }
  }

  enum UploadError: LocalizedError {
    case tooLarge, noAnswer, refused(String)
    var errorDescription: String? {
      switch self {
      case .tooLarge: "That picture is too large to send, even scaled down."
      case .noAnswer: "Your Mac didn't take the attachment. It may be asleep, or coool isn't running."
      case .refused(let e): "Your Mac refused the attachment: \(e)"
      }
    }
  }

  /// Sends pictures to the Mac (scaled down first, encrypted like everything else); returns their upload ids.
  func upload(_ pics: [UIImage]) async throws -> [String] {
    try await upload(pics.map { Attachment(image: $0) })
  }

  /// Sends pictures and files to the Mac (pictures scaled down first; files as they are, a PDF or text within the
  /// size limit; encrypted like everything else); returns their upload ids.
  func upload(_ atts: [Attachment]) async throws -> [String] {
    if demo { return atts.map { _ in randomId() } }
    var ids: [String] = []
    for a in atts.prefix(Remote.maxAttach) {
      switch a.kind {
      case .image:
        guard let img = a.image, let data = Self.shrink(img) else { throw UploadError.tooLarge }
        ids.append(try await sendParts(data, kind: .image, ext: nil))
      case .file:
        guard let data = a.data else { throw UploadError.tooLarge }
        if let why = Attachment.refusal(file: data) { throw UploadError.refused(why) }
        ids.append(try await sendParts(data, kind: .file, ext: a.ext))
      }
    }
    return ids
  }

  /// One upload in parts; waits for the Mac's answer to the last one. Returns the upload id.
  private func sendParts(_ data: Data, kind: UploadKind, ext: String?) async throws -> String {
    let id = randomId()
    let r: CommandResult? = await withCheckedContinuation { c in
      uploadWaiters[id] = c
      Task {
        do {
          for part in uploadParts(id: id, data, kind: kind, ext: ext) {
            let env = try await self.send(.upload(part))
            self.uploadOf[env] = id
          }
        } catch {
          if let w = self.uploadWaiters.removeValue(forKey: id) { w.resume(returning: nil) }
          return
        }
        try? await Task.sleep(for: .seconds(45))
        if let w = self.uploadWaiters.removeValue(forKey: id) { w.resume(returning: nil) }
      }
    }
    guard let r else { throw UploadError.noAnswer }
    guard r.ok else { throw UploadError.refused(r.error ?? "unknown") }
    return id
  }

  /// JPEG, 1600 px on the long side at most, under the protocol's limit.
  nonisolated static func shrink(_ img: UIImage) -> Data? {
    for (edge, q) in [(1600.0, 0.72), (1280.0, 0.65), (1024.0, 0.6), (800.0, 0.55)] {
      let s = img.size
      let k = min(1, edge / max(s.width, s.height, 1))
      let size = CGSize(width: (s.width * k).rounded(), height: (s.height * k).rounded())
      let f = UIGraphicsImageRendererFormat.default()
      f.scale = 1
      let out = UIGraphicsImageRenderer(size: size, format: f).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
      if let d = out.jpegData(compressionQuality: q), d.count <= Remote.maxUpload { return d }
    }
    return nil
  }

  /// Recent prompts started from this phone (newest first), to start again or duplicate.
  struct Recent: Codable, Equatable, Identifiable {
    var text: String
    var project: String
    var projectName: String
    var cli: Cli
    var model: String?
    var mode: String?
    var at: Double
    var id: String { "\(at)" }
  }

  var recents: [Recent] {
    get { (UserDefaults.standard.data(forKey: "recents")).flatMap { try? JSONDecoder().decode([Recent].self, from: $0) } ?? [] }
    set { UserDefaults.standard.set(try? JSONEncoder().encode(Array(newValue.prefix(12))), forKey: "recents") }
  }

  func remember(_ r: Recent) {
    var all = recents.filter { $0.text != r.text || $0.project != r.project }
    all.insert(r, at: 0)
    recents = all
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
