// A session, live: the conversation as it happens (text streaming in, each step with its tool and target, edits as
// diffs, sub-agents fanning out with their own progress, the turn's tally), images that open full screen, the device
// panels its agent uses, and a composer that sends, steers at the next step, or interrupts, with pictures.

import PhotosUI
import RemoteProtocol
import SwiftUI

struct ChatView: View {
  let sessionId: String
  @Environment(RemoteStore.self) private var store
  @State private var text = ""
  @State private var sending = false
  @State private var stopping = false
  @State private var error: String?
  @State private var when: Delivery = .next
  @State private var pics: [UIImage] = []
  @FocusState private var focused: Bool

  private var session: SessionInfo? { store.session(sessionId) }
  /// The id the Mac's live view goes by: the chat's listed id once known (a started chat is `chat:<n>` first).
  private var liveId: String { store.alias[sessionId] ?? sessionId }
  private var log: LiveLog? { store.logs[liveId] ?? store.logs[sessionId] }
  private var live: ChatLive? { log?.live }
  private var working: Bool { (live?.state ?? session?.state) == "working" }
  private var legacy: [ChatItem] { store.tails[sessionId] ?? [] }

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
          } else if (log?.items.isEmpty ?? true) && legacy.isEmpty {
            HStack(spacing: 10) {
              ProgressView()
              Text(store.live ? "Loading the conversation" : "Waiting for the relay").font(.callout).foregroundStyle(Theme.faint)
            }
            .frame(maxWidth: .infinity).padding(.top, 24)
          }
          if let log {
            ForEach(log.items) { it in
              LiveItemView(item: it, session: liveId, running: working)
                .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
            }
          } else {
            ForEach(Array(legacy.enumerated()), id: \.offset) { _, it in ItemView(item: it) }
          }
          if let t = live?.text, !t.isEmpty, working {
            StreamingText(text: t).id("stream")
          } else if live?.thinking == true {
            HStack(spacing: 8) {
              Pulse(color: Theme.working, size: 6)
              Ticker(text: "Thinking", font: .callout)
            }
            .accessibilityIdentifier("chat.thinking")
          }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .animation(Theme.spring, value: log?.items.count)
      }
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
      .refreshable { _ = try? await store.send(.watch(session: liveId, reset: true)) }
      .onChange(of: log?.items.count) { _, _ in withAnimation(Theme.calm) { proxy.scrollTo("bottom", anchor: .bottom) } }
      .onChange(of: live?.text?.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
      .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
    }
    .background(Theme.bg)
    .safeAreaInset(edge: .bottom) { if session?.chat ?? true { composer } }
    .navigationTitle(session?.title ?? "Chat")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: liveId) { if session?.chat ?? true { await store.watch(liveId) } }
  }

  // ---------------------------------------------------------------- the header: state, step, tally, agents, devices

  @ViewBuilder private var header: some View {
    if let s = session {
      let st = store.status(of: s)
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          if st == .working { Pulse(color: Theme.working, size: 7) } else { StatusDot(status: st) }
          Text(st.label).font(.subheadline.weight(.semibold)).foregroundStyle(st.textColor)
          Spacer(minLength: 4)
          Label(s.project, systemImage: "folder").labelStyle(TightLabel()).font(.footnote).foregroundStyle(Theme.faint).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.state")
        .accessibilityValue(live?.state ?? s.state)
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
          Text("\(s.cli.label)\(s.model.isEmpty ? "" : " · \(s.model)")").font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
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
      .animation(Theme.spring, value: working)
    }
  }

  private func stat(_ n: String, _ label: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(n).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.text).contentTransition(.numericText())
      Text(label).font(.footnote).foregroundStyle(Theme.faint)
    }
  }

  // ---------------------------------------------------------------- the composer

  private var composer: some View {
    VStack(spacing: 8) {
      if let error {
        Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Theme.error)
          .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("chat.error")
      }
      if !pics.isEmpty { PicStrip(pics: $pics) }
      if working && (canSend) {
        Picker("When", selection: $when) {
          Text("At its next step").tag(Delivery.next)
          Text("Interrupt now").tag(Delivery.interrupt)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("chat.when")
      }
      HStack(alignment: .bottom, spacing: 8) {
        AttachMenu(pics: $pics).disabled(sending)
        TextField(working ? "Steer it…" : "Message", text: $text, axis: .vertical)
          .lineLimit(1...6)
          .focused($focused)
          .padding(.horizontal, 14).padding(.vertical, 11)
          .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
          .accessibilityLabel("Message")
          .accessibilityIdentifier("chat.input")
        if working && !canSend {
          Button { Task { await stop() } } label: {
            ZStack {
              if stopping { ProgressView().tint(Theme.onPrimary) } else { Image(systemName: "stop.fill").font(.body.weight(.semibold)) }
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
              if sending { ProgressView().tint(Theme.onPrimary) } else { Image(systemName: "arrow.up").font(.body.weight(.bold)) }
            }
            .frame(width: 44, height: 44)
            .foregroundStyle(Theme.onPrimary).background(Theme.primary.opacity(canSend ? 1 : 0.3), in: Circle())
          }
          .disabled(!canSend)
          .accessibilityLabel(working ? (when == .interrupt ? "Interrupt and send" : "Send at its next step") : "Send")
          .accessibilityIdentifier("chat.send")
        }
      }
    }
    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
    .background(.bar)
    .animation(Theme.calm, value: working)
    .animation(Theme.calm, value: pics.count)
  }

  private var canSend: Bool { !sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pics.isEmpty) }

  private func send() async {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    sending = true
    error = nil
    defer { sending = false }
    var ids: [String] = []
    if !pics.isEmpty {
      do { ids = try await store.upload(pics) } catch {
        self.error = error.localizedDescription
        return
      }
    }
    let how: Delivery = working ? when : .send
    let r = await store.perform(.send(session: liveId, text: t, when: how, attachments: ids))
    switch r {
    case .success(let res) where res.ok:
      text = ""
      pics = []
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    case .success(let res): error = res.error ?? "Your Mac refused the message."
    case .failure(let e): error = e.localizedDescription
    }
  }

  private func stop() async {
    stopping = true
    error = nil
    let r = await store.perform(.stop(session: liveId))
    stopping = false
    switch r {
    case .success(let res) where res.ok: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
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

/// Sub-agents fanning out: each with its label, its step now, and a bar of how far it got.
struct FanOut: View {
  let agents: [LiveAgent]
  var body: some View {
    let most = max(1, agents.map(\.steps).max() ?? 1)
    VStack(alignment: .leading, spacing: 8) {
      Text("\(agents.filter { !$0.done }.count) of \(agents.count) agents working").font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim)
      ForEach(agents) { a in
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            if a.done { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.done).imageScale(.small) } else { Pulse(color: Theme.working, size: 5) }
            Text(a.label).font(.footnote).foregroundStyle(Theme.text).lineLimit(1)
            Spacer(minLength: 4)
            Text("\(a.steps)").font(.caption.monospacedDigit()).foregroundStyle(Theme.faint)
          }
          GeometryReader { g in
            ZStack(alignment: .leading) {
              Capsule().fill(Theme.raised)
              Capsule().fill(a.done ? Theme.done : Theme.working).frame(width: max(6, g.size.width * CGFloat(a.steps) / CGFloat(most)))
            }
          }
          .frame(height: 4)
          if let s = a.step, !a.done { Text(s).font(.caption2).foregroundStyle(Theme.faint).lineLimit(1) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.agent|\(a.id)")
      }
    }
    .padding(.top, 2)
    .animation(Theme.spring, value: agents)
  }
}

/// The reply streaming in, with a caret.
struct StreamingText: View {
  let text: String
  @State private var blink = false
  var body: some View {
    (Text(text).foregroundStyle(Theme.text) + Text(" ▍").foregroundStyle(Theme.working.opacity(blink ? 0.2 : 1)))
      .font(.body)
      .frame(maxWidth: .infinity, alignment: .leading)
      .onAppear { withAnimation(.easeInOut(duration: 0.6).repeatForever()) { blink = true } }
      .accessibilityLabel("Writing: \(text)")
      .accessibilityIdentifier("chat.stream")
  }
}

/// One item of the live view.
struct LiveItemView: View {
  let item: LiveItem
  let session: String
  let running: Bool
  @State private var open = false

  var body: some View {
    switch item.role {
    case "user":
      VStack(alignment: .trailing, spacing: 6) {
        if let imgs = item.images, !imgs.isEmpty {
          HStack(spacing: 6) { ForEach(imgs, id: \.self) { ChatImage(session: session, ref: $0, side: imgs.count == 1 ? 150 : 96) } }
        }
        if let t = item.text, !t.isEmpty {
          HStack {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 4) {
              if item.steer == true { Text("Note for the agent").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint) }
              Text(t).font(.body).foregroundStyle(Theme.text).textSelection(.enabled)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
      .accessibilityElement(children: .contain)
      .accessibilityLabel("You")
    case "assistant":
      MarkdownView(text: item.text ?? "")
        .font(.body)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.assistant")
    case "tool":
      VStack(alignment: .leading, spacing: 8) {
        Button { if item.diff != nil { withAnimation(Theme.spring) { open.toggle() } } } label: {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: ToolLook.icon(item.tool)).font(.footnote).foregroundStyle(Theme.dim).frame(width: 18)
            Text(item.tool ?? "Tool").font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim)
            Text(target).font(.footnote.monospaced()).foregroundStyle(Theme.faint).lineLimit(2).multilineTextAlignment(.leading)
            Spacer(minLength: 4)
            mark
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if let d = item.diff, open || (d.before.count + d.after.count) < 1_200 {
          DiffView(diff: d, maxLines: 14).transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat.item|\(item.k)")
    case "agent":
      HStack(spacing: 10) {
        Image(systemName: "person.2").foregroundStyle(item.ok == nil && running ? Theme.working : Theme.dim)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.text ?? "Agent").font(.footnote.weight(.medium)).foregroundStyle(Theme.text).lineLimit(2)
          Text(item.steps.map { "\($0) steps" } ?? (item.ok == nil ? "Working" : "Done")).font(.caption).foregroundStyle(Theme.faint)
        }
        Spacer(minLength: 4)
        mark
      }
      .padding(10)
      .background(Theme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("chat.item|\(item.k)")
    default:
      Text(item.text ?? "")
        .font(.footnote).foregroundStyle(Theme.faint)
        .frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
        .accessibilityIdentifier("chat.notice")
    }
  }

  @ViewBuilder private var mark: some View {
    switch item.ok {
    case .some(true): Image(systemName: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(Theme.doneText).accessibilityLabel("done")
    case .some(false): Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(Theme.error).accessibilityLabel("failed")
    case .none: if running { ProgressView().controlSize(.mini).tint(Theme.working) }
    }
  }

  /// The summary without the tool's name ("Bash · echo hi" -> "echo hi").
  private var target: String {
    let t = item.text ?? ""
    if let tool = item.tool, t.hasPrefix("\(tool) · ") { return String(t.dropFirst(tool.count + 3)) }
    return t
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

/// A line of an older Mac's chat tail (minor 0).
struct ItemView: View {
  let item: ChatItem

  var body: some View {
    LiveItemView(item: LiveItem(k: "", role: item.role, text: item.text, tool: item.tool), session: "", running: false)
  }
}

// ---------------------------------------------------------------- pictures to send

/// The pictures picked for the next message, each removable.
struct PicStrip: View {
  @Binding var pics: [UIImage]
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(Array(pics.enumerated()), id: \.offset) { i, p in
          ZStack(alignment: .topTrailing) {
            Image(uiImage: p).resizable().scaledToFill().frame(width: 64, height: 64)
              .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Button { _ = withAnimation(Theme.calm) { pics.remove(at: i) } } label: {
              Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
            }
            .offset(x: 6, y: -6)
            .accessibilityLabel("Remove picture \(i + 1)")
          }
          .accessibilityIdentifier("attach.pic|\(i)")
        }
      }
      .padding(.top, 6).padding(.horizontal, 2)
    }
  }
}

/// Add pictures: the photo library, the camera, (debug builds under test) an invented picture.
struct AttachMenu: View {
  @Binding var pics: [UIImage]
  @State private var picking = false
  @State private var camera = false
  @State private var items: [PhotosPickerItem] = []

  var body: some View {
    Menu {
      Button { picking = true } label: { Label("Photo library", systemImage: "photo.on.rectangle") }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button { camera = true } label: { Label("Take a photo", systemImage: "camera") }
      }
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--e2e-image") {
          Button { pics.append(testPicture()) } label: { Label("Test picture", systemImage: "circle.fill") }
            .accessibilityIdentifier("attach.test")
        }
      #endif
    } label: {
      Image(systemName: "plus").font(.body.weight(.semibold)).foregroundStyle(Theme.text)
        .frame(width: 44, height: 44).background(Theme.card, in: Circle())
        .overlay(Circle().strokeBorder(Theme.border, lineWidth: 0.5))
    }
    .disabled(pics.count >= Remote.maxAttach)
    .accessibilityLabel("Add a picture")
    .accessibilityIdentifier("chat.attach")
    .photosPicker(isPresented: $picking, selection: $items, maxSelectionCount: Remote.maxAttach - pics.count, matching: .images)
    .onChange(of: items) { _, new in
      Task {
        for it in new {
          if let d = try? await it.loadTransferable(type: Data.self), let img = UIImage(data: d) { pics.append(img) }
        }
        items = []
      }
    }
    .fullScreenCover(isPresented: $camera) { CameraPicker { if let i = $0 { pics.append(i) } }.ignoresSafeArea() }
  }
}

#if DEBUG
  /// An invented picture for the end-to-end run: a yellow circle on a blue square, simple for any model to describe.
  func testPicture() -> UIImage {
    let size = CGSize(width: 512, height: 512)
    let f = UIGraphicsImageRendererFormat.default()
    f.scale = 1
    return UIGraphicsImageRenderer(size: size, format: f).image { ctx in
      UIColor(red: 0.05, green: 0.25, blue: 0.85, alpha: 1).setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
      UIColor(red: 1, green: 0.85, blue: 0.1, alpha: 1).setFill()
      ctx.cgContext.fillEllipse(in: CGRect(x: 106, y: 106, width: 300, height: 300))
    }
  }
#endif

/// The camera, for a photo to send.
struct CameraPicker: UIViewControllerRepresentable {
  let done: (UIImage?) -> Void
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let p = UIImagePickerController()
    p.sourceType = .camera
    p.delegate = context.coordinator
    return p
  }
  func updateUIViewController(_ c: UIImagePickerController, context: Context) {}
  func makeCoordinator() -> Coordinator { Coordinator(done) }
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let done: (UIImage?) -> Void
    init(_ d: @escaping (UIImage?) -> Void) { done = d }
    func imagePickerController(_ p: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      done(info[.originalImage] as? UIImage)
      p.dismiss(animated: true)
    }
    func imagePickerControllerDidCancel(_ p: UIImagePickerController) {
      done(nil)
      p.dismiss(animated: true)
    }
  }
}
