// A session, live: the conversation as it happens, and a composer with what the Mac's has (Composer.swift).
//
// How it should feel (and what the first phone build got wrong, measured from Simulator recordings on an iPhone SE):
// - What you send appears at once as a bubble (sending, then sent), and the Mac's own copy takes over that same row
//   when it arrives, so nothing jumps; a failure shows a quiet "Not sent · Retry" on the bubble.
// - The list stays pinned to the bottom while you are there, and stays put when you scrolled up (a "New messages"
//   button takes you down). It rides the keyboard.
// - A reply streams as flowing text: the Mac sends what changed about once a second; the phone reveals it at the rate
//   it arrives, a word at a time, and the reply that ends the stream keeps the stream's row.
// - Rows are lazy and equatable, so a streaming token re-renders one row, not the whole conversation.

import RemoteProtocol
import SwiftUI

struct ChatView: View {
  let sessionId: String
  @Environment(RemoteStore.self) private var store
  @State private var atBottom = true
  /// New rows that arrived while scrolled up.
  @State private var missed = 0
  @State private var jump = 0
  /// The streaming row's height: when it grows by a line, the list follows (if the person is at the bottom).
  @State private var grew: CGFloat = 0
  /// The content's height (iOS 18): any growth while at the bottom (a reply finishing its reveal, a notice, an image
  /// arriving) keeps the bottom in view.
  @State private var grown: CGFloat = 0

  private var session: SessionInfo? { store.session(sessionId) }
  /// The id the Mac's live view goes by: the chat's listed id once known (a started chat is `chat:<n>` first).
  private var liveId: String { store.alias[sessionId] ?? sessionId }
  private var log: LiveLog? { store.logs[liveId] ?? store.logs[sessionId] }
  private var live: ChatLive? { log?.live }
  private var working: Bool { (live?.state ?? session?.state) == "working" }
  private var legacy: [ChatItem] { store.tails[sessionId] ?? [] }
  private var streaming: String? { working ? live?.text.flatMap { $0.isEmpty ? nil : $0 } : nil }

  enum Row: Identifiable {
    case item(LiveItem, id: String)
    case out(Outgoing)
    case stream(String, id: String)
    var id: String {
      switch self {
      case .item(_, let id), .stream(_, let id): id
      case .out(let o): o.id
      }
    }
  }

  private var rows: [Row] {
    var r: [Row] = (log?.items ?? []).map { .item($0, id: store.rowId($0)) }
    r += (store.outbox[liveId] ?? []).filter { !$0.isNote }.map { .out($0) }
    if let t = streaming { r.append(.stream(t, id: store.streamIds[liveId] ?? "stream:new")) }
    return r
  }

  var body: some View {
    let rows = rows
    VStack(spacing: 0) {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          header
          if let mode = store.startedMode[sessionId] {
            Label("Started from this iPhone. \(modeWords(mode))", systemImage: "iphone")
              .font(.footnote).foregroundStyle(Theme.dim)
              .accessibilityIdentifier("chat.started|\(sessionId)|\(mode)")
          }
          if let n = store.need(for: sessionId) ?? store.need(for: liveId) {
            NavigationLink(value: Route.need(n.id)) {
              VStack(alignment: .leading, spacing: 8) {
                NeedRow(need: n, title: nil)
                Text("Open to answer").font(.footnote.weight(.semibold)).foregroundStyle(Theme.needsText)
              }
              .tile(stroke: Theme.needs)
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("chat.need|\(n.id)")
            .transition(.move(edge: .top).combined(with: .opacity))
          }
          if session?.chat == false {
            Text("This session runs outside coool's chats (in a terminal, for example), so from here it can only be watched.")
              .font(.callout).foregroundStyle(Theme.dim).tile()
          } else if rows.isEmpty && legacy.isEmpty {
            HStack(spacing: 10) {
              ProgressView()
              Text(store.live ? "Loading the conversation" : "Waiting for the relay").font(.callout).foregroundStyle(Theme.faint)
            }
            .frame(maxWidth: .infinity).padding(.top, 24)
          }
          if log != nil || !rows.isEmpty {
            ForEach(rows) { row in
              rowView(row).transition(Self.arrive)
            }
          } else {
            ForEach(Array(legacy.enumerated()), id: \.offset) { _, it in ItemView(item: it) }
          }
          if streaming == nil, live?.thinking == true, working {
            HStack(spacing: 8) {
              Pulse(color: Theme.working, size: 6)
              Ticker(text: "Thinking", font: .callout)
            }
            .accessibilityIdentifier("chat.thinking")
            .transition(.opacity)
          }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
      }
      .modifier(StickToBottom(atBottom: $atBottom, grown: $grown))
      .scrollDismissesKeyboard(.interactively)
      // A tap on the conversation puts the keyboard away (and brings back the chat's state row under the field).
      .simultaneousGesture(TapGesture().onEnded { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) })
      .refreshable { _ = try? await store.send(.watch(session: liveId, reset: true)) }
      .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
      .onChange(of: rows.count) { old, new in
        if atBottom {
          pin(proxy, animated: true)
        } else if new > old {
          missed += new - old
        }
      }
      .onChange(of: grown) { old, new in
        if atBottom, new > old { withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("bottom", anchor: .bottom) } }
      }
      .onChange(of: grew) { _, _ in
        // The stream grew by a line: glide down with it.
        if atBottom { withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo("bottom", anchor: .bottom) } }
      }
      .onChange(of: atBottom) { _, b in if b { missed = 0 } }
      .onChange(of: jump) { _, _ in
        atBottom = true
        missed = 0
        pin(proxy, animated: true)
      }
      .overlay(alignment: .bottom) {
        if !atBottom && (missed > 0 || streaming != nil) {
          Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            jump += 1
          } label: {
            Label(missed > 0 ? (missed == 1 ? "1 new" : "\(missed) new") : "Writing", systemImage: "arrow.down")
              .font(.footnote.weight(.semibold))
              .padding(.horizontal, 12).padding(.vertical, 8)
              .foregroundStyle(Theme.text)
              .background(.regularMaterial, in: Capsule())
              .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 0.5))
              .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
          }
          .padding(.bottom, 10)
          .transition(.scale(scale: 0.8).combined(with: .opacity))
          .accessibilityIdentifier("chat.jump")
        }
      }
      .animation(Theme.settle, value: !atBottom && (missed > 0 || streaming != nil))
    }
      // The composer sits under the list (not over it): the list's bottom is always the composer's top, and both
      // ride the keyboard together.
      if session?.chat ?? true {
        Composer(session: liveId, info: session, log: log, working: working) { jump += 1 }
      }
    }
    .background(Theme.bg)
    // The chat's state for VoiceOver and tests, always present (the header scrolls away in the lazy list).
    .overlay(alignment: .topLeading) {
      Color.clear.frame(width: 1, height: 1)
        .accessibilityElement()
        .accessibilityLabel("Chat state")
        .accessibilityValue(live?.state ?? session?.state ?? "")
        .accessibilityIdentifier("chat.state")
    }
    .navigationTitle(session?.title ?? "Chat")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: liveId) { if session?.chat ?? true { await store.watch(liveId) } }
  }

  /// To the bottom: now, and again on the next frame (a row inserted this frame is laid out by then).
  private func pin(_ proxy: ScrollViewProxy, animated: Bool) {
    let go = { proxy.scrollTo("bottom", anchor: .bottom) }
    if animated { withAnimation(Theme.settle, go) } else { go() }
    DispatchQueue.main.async { if animated { withAnimation(Theme.settle, go) } else { go() } }
  }

  /// A row arriving: it rises a little and fades in, from the bottom edge (the list grows upwards).
  static let arrive = AnyTransition.asymmetric(insertion: .opacity.combined(with: .offset(y: 14)), removal: .opacity)

  @ViewBuilder private func rowView(_ row: Row) -> some View {
    switch row {
    case .out, .item where Self.isUser(row):
      // One branch for a message on its way and the Mac's copy of it, so the copy keeps the same view: it settles in
      // place (the status line fades), with no cross-fade or jump.
      userRow(row)
    case .item(let it, _) where it.role != "assistant":
      LiveItemView(item: it, session: liveId, running: working).equatable()
    case .item, .stream:
      // One branch for the stream and the reply that ends it, so the reply keeps the stream's view (and its state):
      // the text doesn't cross-fade or jump when the stream becomes final.
      let (t, flowing): (String, Bool) = {
        if case .stream(let t, _) = row { return (t, true) }
        if case .item(let it, _) = row { return (it.text ?? "", false) }
        return ("", false)
      }()
      FlowText(text: t, flowing: flowing)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in if flowing { grew = h } }
    }
  }

  static func isUser(_ row: Row) -> Bool {
    if case .item(let it, _) = row { return it.role == "user" }
    if case .out = row { return true }
    return false
  }

  private func userRow(_ row: Row) -> some View {
    let o: Outgoing? = { if case .out(let o) = row { return o } else { return nil } }()
    let it: LiveItem? = { if case .item(let it, _) = row { return it } else { return nil } }()
    // A settled message shows the pictures it was sent with until the Mac's copies of them arrive.
    let pics = o?.attachments.compactMap(\.image) ?? []
    return UserBubble(text: o?.text ?? it?.text, images: it?.images ?? [], pics: pics, files: o?.attachments.filter { $0.kind == .file }.map(\.name) ?? [], steer: it?.steer == true, session: liveId, status: o?.state)
      .contextMenu {
        if let o {
          if case .failed = o.state { Button { store.retry(o) } label: { Label("Retry", systemImage: "arrow.clockwise") } }
          Button(role: .destructive) { store.discard(o) } label: { Label("Remove", systemImage: "trash") }
        }
      }
      .onTapGesture { if let o, case .failed = o.state { store.retry(o) } }
      .accessibilityIdentifier(o.map { "chat.out|\($0.id)" } ?? "chat.user")
  }

  // ---------------------------------------------------------------- the header: state, step, tally, agents, devices

  @ViewBuilder private var header: some View {
    if let s = session {
      let st = store.status(of: s)
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          if st == .working { Pulse(color: Theme.working, size: 7) } else { StatusDot(status: st) }
          Text(st.label).font(.subheadline.weight(.semibold)).foregroundStyle(st.textColor).contentTransition(.opacity)
          Spacer(minLength: 4)
          Label(s.project, systemImage: "folder").labelStyle(TightLabel()).font(.footnote).foregroundStyle(Theme.faint).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.header")
        if working, let step = live?.step ?? s.step {
          let (tool, target) = ToolLook.split(step)
          HStack(spacing: 8) {
            Image(systemName: ToolLook.icon(tool)).foregroundStyle(Theme.working)
            Ticker(text: target.isEmpty ? tool : "\(tool)  \(target)", font: .callout)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("chat.live.step")
        }
        HStack(spacing: 14) {
          if let t = live?.tally {
            stat("\(t.steps)", t.steps == 1 ? "step" : "steps")
            if t.edits > 0 { stat("\(t.edits)", t.edits == 1 ? "edit" : "edits") }
            if let since = t.since, working { Elapsed(since: since, font: .subheadline.monospacedDigit().weight(.medium), color: Theme.text) }
          }
          Spacer(minLength: 0)
          let model = log?.meta?.model ?? s.model
          Text("\(s.cli.label)\(model.isEmpty ? "" : " · \(modelName(model))")").font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.tally")
        if let agents = live?.agents, !agents.isEmpty { FanOut(agents: agents) }
        if let ds = live?.devices, !ds.isEmpty {
          HStack(spacing: 8) {
            ForEach(ds, id: \.self) { d in
              NavigationLink(value: Route.device(liveId, d)) {
                HStack(spacing: 6) {
                  Image(systemName: d.deviceIcon)
                  Text("Watch the \(d.deviceLabel)")
                  Image(systemName: "chevron.right").imageScale(.small)
                }
                .font(.footnote.weight(.medium)).foregroundStyle(Theme.text)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.raised, in: Capsule())
              }
              .buttonStyle(PressStyle())
              .accessibilityIdentifier("chat.device|\(d)")
            }
          }
        }
      }
      .tile(stroke: st == .working ? Theme.working.opacity(0.45) : nil)
      .animation(Theme.settle, value: working)
    }
  }

  private func stat(_ n: String, _ label: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(n).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.text).contentTransition(.numericText())
      Text(label).font(.footnote).foregroundStyle(Theme.faint)
    }
  }

  private func modeWords(_ mode: String) -> String {
    switch mode {
    case "default", "untrusted": "It asks before it runs commands."
    case "acceptEdits": "It edits files and asks before commands."
    case "plan": "It plans first and asks before acting."
    case "on-request": "It asks when it needs more access."
    default: "Mode: \(mode)."
    }
  }
}

/// Keeps the list at the bottom while the person is there, and says whether they are. iOS 18 and later: the scroll
/// view itself keeps the bottom anchored as content grows (no scroll commands per token); iOS 17: a scroll per change.
struct StickToBottom: ViewModifier {
  @Binding var atBottom: Bool
  @Binding var grown: CGFloat

  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content
        .defaultScrollAnchor(.bottom)
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, h in grown = h }
        .onScrollPhaseChange { old, phase, ctx in
          // Only the person's own scrolling decides whether they left the bottom (content growing, the keyboard
          // coming up, or a programmatic scroll never do).
          guard phase == .idle, old == .interacting || old == .decelerating else { return }
          let g = ctx.geometry
          let b = g.contentSize.height + g.contentInsets.bottom - g.containerSize.height - g.contentOffset.y < 60
          if b != atBottom { atBottom = b }
        }
    } else {
      content.defaultScrollAnchor(.bottom)
    }
  }
}

/// A reply as Markdown, revealed as it streams. The Mac sends the text in steps about a second apart; this shows it
/// at the rate it arrives, a word at a time, so it reads as continuous. When the reply is final (`flowing` false) the
/// rest is shown quickly, or at once if it was never streaming here.
struct FlowText: View {
  let text: String
  let flowing: Bool
  @State private var shown = -1
  @State private var rate = 80.0
  @State private var lastLen = 0
  @State private var lastAt = Date()

  var body: some View {
    let n = shown < 0 ? text.count : min(shown, text.count)
    let visible = Self.prefix(text, n)
    MarkdownView(text: flowing || n < text.count ? visible + " ▍" : visible)
      .font(.body)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(flowing ? "Writing: \(text)" : text)
      .accessibilityIdentifier(flowing ? "chat.stream" : "chat.assistant")
      .task(id: "\(text.count)|\(flowing)") { await reveal() }
  }

  /// The first `n` characters; mid-reveal, an open code span is closed so its backtick doesn't show raw.
  static func prefix(_ text: String, _ n: Int) -> String {
    guard n < text.count else { return text }
    let v = String(text.prefix(n))
    return v.filter { $0 == "`" }.count % 2 == 1 ? v + "`" : v
  }

  private func reveal() async {
    let target = text.count
    let now = Date()
    if shown < 0 {
      // A reply seen whole: no reveal. A stream that just began: from its first word (its first step can hold many
      // lines; shown at once it would jump), caught up within about a second.
      shown = flowing ? 0 : target
      if flowing {
        lastLen = 0
        lastAt = now.addingTimeInterval(-0.8)
        await reveal()
        return
      }
      lastLen = target
      lastAt = now
      return
    }
    if target < shown { shown = target }
    let dt = now.timeIntervalSince(lastAt)
    let added = target - lastLen
    if added > 0, dt > 0.15 { rate = rate * 0.5 + (Double(added) / dt) * 0.5 }
    lastLen = target
    lastAt = now
    while shown < target, !Task.isCancelled {
      let backlog = Double(target - shown)
      var r = max(rate, 40)
      if !flowing {
        r = max(r, backlog / 0.35)
      } else if backlog / r > 1.1 {
        r = backlog / 0.9
      }
      try? await Task.sleep(for: .milliseconds(33))
      if Task.isCancelled { return }
      shown = min(target, wordEnd(text, shown + max(1, Int(r * 0.033))))
    }
  }

  /// The end of the word at `i` (up to a few characters on), so the reveal moves a word at a time.
  private func wordEnd(_ t: String, _ i: Int) -> Int {
    guard i < t.count else { return t.count }
    var j = i
    var idx = t.index(t.startIndex, offsetBy: i)
    while j < t.count, j < i + 10, !t[idx].isWhitespace {
      j += 1
      idx = t.index(after: idx)
    }
    return j
  }
}

/// The person's message: what the Mac has (`status` nil), or one on its way (sending, sent, not sent).
struct UserBubble: View {
  let text: String?
  var images: [ImageRef] = []
  var pics: [UIImage] = []
  let files: [String]
  let steer: Bool
  let session: String
  let status: Outgoing.State?

  var body: some View {
    VStack(alignment: .trailing, spacing: 5) {
      if !images.isEmpty || !pics.isEmpty {
        HStack(spacing: 6) {
          ForEach(images, id: \.self) { ChatImage(session: session, ref: $0, side: images.count + pics.count == 1 ? 150 : 96) }
          ForEach(Array(pics.enumerated()), id: \.offset) { _, p in
            Image(uiImage: p).resizable().scaledToFill().frame(width: pics.count == 1 ? 150 : 96, height: pics.count == 1 ? 150 : 96)
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
        }
      }
      ForEach(files, id: \.self) { f in
        Label(f, systemImage: "doc.text").font(.footnote).foregroundStyle(Theme.dim)
          .padding(.horizontal, 10).padding(.vertical, 6).background(Theme.raised, in: Capsule())
      }
      if let t = text, !t.isEmpty {
        HStack {
          Spacer(minLength: 48)
          VStack(alignment: .leading, spacing: 4) {
            if steer { Text("Note for the agent").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint) }
            Text(t).font(.body).foregroundStyle(Theme.text).textSelection(.enabled)
          }
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .opacity(status == .sending ? 0.82 : 1)
        }
      }
      if let status {
        statusLine(status).transition(.opacity)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .animation(Theme.settle, value: status)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("You")
  }

  @ViewBuilder private func statusLine(_ s: Outgoing.State) -> some View {
    switch s {
    case .sending:
      Text("Sending").font(.caption2).foregroundStyle(Theme.faint).accessibilityIdentifier("chat.out.sending")
    case .sent:
      Label("Sent", systemImage: "checkmark").labelStyle(TightLabel()).font(.caption2).foregroundStyle(Theme.faint).accessibilityIdentifier("chat.out.sent")
    case .failed(let why):
      Label("Not sent · Tap to retry", systemImage: "exclamationmark.circle").labelStyle(TightLabel()).font(.caption2.weight(.medium)).foregroundStyle(Theme.error)
        .accessibilityHint(why).accessibilityIdentifier("chat.out.failed")
    }
  }
}
