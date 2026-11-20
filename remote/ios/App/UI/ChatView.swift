import RemoteProtocol
import SwiftUI

struct ChatView: View {
  let sessionId: String
  @Environment(RemoteStore.self) private var store
  @State private var text = ""
  @State private var sending = false
  @State private var stopping = false
  @State private var error: String?
  @FocusState private var focused: Bool

  private var session: SessionInfo? { store.session(sessionId) }
  private var items: [ChatItem] { store.tails[sessionId] ?? [] }
  private var working: Bool { session?.state == "working" }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header
          if let mode = store.startedMode[sessionId] {
            Label("Started from this iPhone. \(modeWords(mode))", systemImage: "iphone")
              .font(.footnote).foregroundStyle(Theme.dim)
              .accessibilityIdentifier("chat.started|\(sessionId)|\(mode)")
          }
          if let n = store.need(for: sessionId) {
            NavigationLink(value: Route.need(n.id)) {
              Card(stroke: Theme.needs) {
                NeedRow(need: n, title: nil)
                Text("Open to answer").font(.footnote.weight(.medium)).foregroundStyle(Theme.needsText)
              }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat.need|\(n.id)")
          }
          if session?.chat == false {
            Card {
              Text("This session runs outside coool's chats (in a terminal, for example), so from here it can only be watched.")
                .font(.callout).foregroundStyle(Theme.dim)
            }
          } else if items.isEmpty {
            Text(store.live ? "Loading the conversation" : "Waiting for the relay").font(.callout).foregroundStyle(Theme.faint)
              .frame(maxWidth: .infinity).padding(.top, 24)
          }
          ForEach(Array(items.enumerated()), id: \.offset) { _, it in ItemView(item: it) }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: items.count) { _, _ in withAnimation(Theme.calm) { proxy.scrollTo("bottom", anchor: .bottom) } }
      .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
    }
    .background(Theme.bg)
    .safeAreaInset(edge: .bottom) { if session?.chat ?? true { composer } }
    .navigationTitle(session?.title ?? "Chat")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: sessionId) {
      // The tail, now and then again while the chat works (the Mac sends state changes, not every line).
      while !Task.isCancelled {
        if session?.chat ?? true { await store.requestTail(sessionId) }
        try? await Task.sleep(for: .seconds(working ? 3 : 12))
      }
    }
    .onChange(of: session?.state) { _, _ in Task { await store.requestTail(sessionId) } }
  }

  @ViewBuilder private var header: some View {
    if let s = session {
      let st = store.status(of: s)
      HStack(spacing: 8) {
        StatusDot(status: st)
        Text(st.label).foregroundStyle(st.textColor)
        Text("·").foregroundStyle(Theme.faint)
        Label(s.cli.label, systemImage: s.cli.glyph).foregroundStyle(Theme.faint)
        Text("·").foregroundStyle(Theme.faint)
        Label(s.project, systemImage: "folder").foregroundStyle(Theme.faint).lineLimit(1)
      }
      .font(.footnote)
      .labelStyle(TightLabel())
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("chat.state")
      .accessibilityValue(s.state)
    }
  }

  private var composer: some View {
    VStack(spacing: 6) {
      if let error {
        Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Theme.error)
          .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("chat.error")
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message", text: $text, axis: .vertical)
          .lineLimit(1...6)
          .focused($focused)
          .padding(.horizontal, 14).padding(.vertical, 11)
          .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
          .accessibilityLabel("Message")
          .accessibilityIdentifier("chat.input")
        if working && text.isEmpty {
          Button { Task { await stop() } } label: {
            ZStack {
              if stopping { ProgressView() } else { Image(systemName: "stop.fill").font(.body.weight(.semibold)) }
            }
            .frame(width: 44, height: 44)
            .foregroundStyle(Theme.onPrimary).background(Theme.primary, in: Circle())
          }
          .disabled(stopping)
          .accessibilityLabel("Stop")
          .accessibilityIdentifier("chat.stop")
        } else {
          Button { Task { await send() } } label: {
            ZStack {
              if sending { ProgressView() } else { Image(systemName: "arrow.up").font(.body.weight(.bold)) }
            }
            .frame(width: 44, height: 44)
            .foregroundStyle(Theme.onPrimary).background(Theme.primary.opacity(canSend ? 1 : 0.3), in: Circle())
          }
          .disabled(!canSend)
          .accessibilityLabel("Send")
          .accessibilityIdentifier("chat.send")
        }
      }
    }
    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
    .background(.bar)
  }

  private var canSend: Bool { !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  private func send() async {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    sending = true
    error = nil
    let r = await store.perform(.send(session: sessionId, text: t))
    sending = false
    switch r {
    case .success(let res) where res.ok:
      text = ""
      await store.requestTail(sessionId)
    case .success(let res): error = res.error ?? "Your Mac refused the message."
    case .failure(let e): error = e.localizedDescription
    }
  }

  private func stop() async {
    stopping = true
    error = nil
    let r = await store.perform(.stop(session: sessionId))
    stopping = false
    switch r {
    case .success(let res) where res.ok:
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      await store.requestTail(sessionId)
    case .success(let res): error = res.error ?? "Your Mac refused to stop the chat."
    case .failure(let e): error = e.localizedDescription
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

struct TightLabel: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) {
      configuration.icon.imageScale(.small)
      configuration.title
    }
  }
}

struct ItemView: View {
  let item: ChatItem

  var body: some View {
    switch item.role {
    case "user":
      HStack {
        Spacer(minLength: 48)
        Text(item.text ?? "")
          .font(.body).foregroundStyle(Theme.text)
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .textSelection(.enabled)
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("You: \(item.text ?? "")")
    case "assistant":
      Text(markdown(item.text ?? ""))
        .font(.body).foregroundStyle(Theme.text).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("chat.assistant")
    case "tool":
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(item.tool ?? "Tool").font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim)
          .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.raised, in: Capsule())
        Text(toolText).font(.footnote.monospaced()).foregroundStyle(Theme.faint).lineLimit(3)
      }
      .accessibilityElement(children: .combine)
    default:
      Text(item.text ?? "")
        .font(.footnote).foregroundStyle(Theme.faint)
        .frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
        .accessibilityIdentifier("chat.notice")
    }
  }

  /// The Mac's summary may start with the tool's name ("Bash · echo hi"): shown once, in the capsule.
  private var toolText: String {
    let t = item.text ?? ""
    if let tool = item.tool, t.hasPrefix("\(tool) · ") { return String(t.dropFirst(tool.count + 3)) }
    return t
  }

  private func markdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
  }
}
