// The chat's message box, with what the Mac's composer has, in a form for a phone: a compact bar (add, the field with
// the microphone, one button that morphs between send and stop), a row of the chat's state above it (model, mode,
// context, Ladder, commands) and a tray for the rest.
//
// - Sending while the agent works queues a note, as Enter does on the Mac: it goes in at the agent's next step, or
//   (Interrupt) cuts the step and goes in now. Queued notes show in a strip above the field, with the Mac's own
//   states, and can be delivered now, edited (taken back into the field) or removed until the agent picks them up.
// - Pictures (library, camera, paste) and files (PDFs, text, code), several per message.
// - The model: the Mac's list for that chat; switching goes through the Mac's own path, or says why it can't.
// - The permission mode: shown, read only (it can be changed only on the Mac).
// - Voice: hold the microphone to talk (or tap to start and stop); the recording goes to the Mac, encrypted, and its
//   dictation (the owner's model, translation to English, their word memory) turns it into text for review here.
// - Slash commands: the CLI's list, searchable, from "/" or the tray. Context used and the window, as the Mac shows.
// - The draft is kept per chat.

import PhotosUI
import RemoteProtocol
import SwiftUI
import UniformTypeIdentifiers

struct Composer: View {
  let session: String
  let info: SessionInfo?
  let log: LiveLog?
  let working: Bool
  /// Something was sent: the transcript goes to the bottom.
  let sent: () -> Void
  @Environment(RemoteStore.self) private var store
  @State private var text = ""
  @State private var atts: [Attachment] = []
  @State private var when: Delivery = .next
  @State private var error: String?
  @State private var tray = false
  @State private var commands = false
  @State private var modeInfo = false
  @State private var context = false
  @State private var stopping = false
  @State private var switching: String?
  @State private var voiceNote: String?
  @State private var dismissed: Set<String> = []
  @State private var voice = VoiceCapture()
  @State private var loaded = false
  @FocusState private var focused: Bool

  private var meta: ChatMeta? { log?.meta }
  private var notes: [LiveNote] { log?.live?.notes ?? [] }
  private var pending: [Outgoing] { (store.outbox[session] ?? []).filter(\.isNote) }
  private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var blocked: Bool { working && store.need(for: session) != nil }
  private var canSend: Bool { (hasText || !atts.isEmpty) && !(blocked && !text.hasPrefix("/")) }
  private var slashQuery: String? {
    guard text.hasPrefix("/"), !text.contains(" "), !text.contains("\n") else { return nil }
    return String(text.dropFirst())
  }

  var body: some View {
    VStack(spacing: 8) {
      if let error {
        Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Theme.error)
          .frame(maxWidth: .infinity, alignment: .leading)
          .onTapGesture { withAnimation(Theme.settle) { self.error = nil } }
          .accessibilityIdentifier("chat.error")
          .transition(.opacity)
      }
      NotesStrip(session: session, notes: notes.filter { !dismissed.contains($0.id) }, pending: pending, working: working, edit: edit, dismiss: { dismissed.insert($0) }, resend: resend)
      if voice.phase == .idle, let q = slashQuery, let list = meta?.commands, !list.isEmpty {
        SlashList(commands: list, query: q) { pick($0) }
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
      if !atts.isEmpty {
        AttachStrip(atts: $atts).transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      if let v = voiceNote {
        Label(v, systemImage: "waveform").labelStyle(TightLabel()).font(.caption).foregroundStyle(Theme.faint)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("voice.note")
      }
      if working && canSend && !text.hasPrefix("/") {
        WhenToggle(when: $when).transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
      }
      if voice.phase != .idle {
        RecordingBar(voice: voice, done: { Task { await finishVoice() } }, cancel: { voice.cancel() })
          .transition(.opacity.combined(with: .scale(scale: 0.98)))
      } else {
        bar
      }
      if !focused && voice.phase == .idle {
        MetaRow(meta: meta, info: info, switching: switching, model: { m in Task { await switchModel(m) } }, mode: { modeInfo = true }, context: { context = true }, commands: { commands = true })
          .transition(.opacity)
      }
    }
    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
    .background(.bar)
    .animation(Theme.settle, value: working)
    .animation(Theme.settle, value: atts.count)
    .animation(Theme.settle, value: focused)
    .animation(Theme.settle, value: voice.phase)
    .animation(Theme.settle, value: slashQuery == nil)
    .animation(Theme.settle, value: hasText)
    .sheet(isPresented: $tray) {
      Tray(atts: $atts, meta: meta, info: info, error: $error, model: { m in Task { await switchModel(m) } }, commands: { tray = false; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { commands = true } })
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .sheet(isPresented: $commands) {
      CommandsSheet(commands: meta?.commands ?? [], cli: meta?.cli ?? info?.cli.rawValue) { c in
        commands = false
        pick(c)
      }
      .presentationDetents([.medium, .large])
    }
    .sheet(isPresented: $context) {
      ContextSheet(meta: meta, info: info).presentationDetents([.medium])
    }
    .alert("Permission mode", isPresented: $modeInfo) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("This chat runs in “\(meta?.modeLabel ?? meta?.mode ?? "its mode")”. A running chat's mode can be changed only on the Mac, never from the phone.")
    }
    .onAppear {
      guard !loaded else { return }
      loaded = true
      text = Drafts.get(session)
      #if DEBUG
        Demo.compose(self.store, session: session, text: &text, atts: &atts, voice: voice, error: &error)
      #endif
    }
    .onChange(of: text) { _, t in
      Drafts.set(session, t)
      if t.isEmpty { voiceNote = nil }
    }
  }

  // ---------------------------------------------------------------- the bar

  private var bar: some View {
    HStack(alignment: .bottom, spacing: 8) {
      Button {
        UISelectionFeedbackGenerator().selectionChanged()
        tray = true
      } label: {
        Image(systemName: "plus").font(.body.weight(.semibold)).foregroundStyle(Theme.text)
          .frame(width: 40, height: 40).background(Theme.card, in: Circle())
          .overlay(Circle().strokeBorder(Theme.border, lineWidth: 0.5))
      }
      .buttonStyle(PressStyle())
      .accessibilityLabel("Add pictures or files, model and more")
      .accessibilityIdentifier("chat.attach")
      HStack(alignment: .bottom, spacing: 4) {
        TextField(placeholder, text: $text, axis: .vertical)
          .lineLimit(1...6)
          .focused($focused)
          .padding(.leading, 14).padding(.vertical, 10)
          .accessibilityLabel("Message")
          .accessibilityIdentifier("chat.input")
        // Dictation runs on the Mac: offered when the Mac says it can (minor 2).
        if !hasText && (store.macMinor >= 2 || store.demo) {
          MicButton(voice: voice, start: startVoice, finish: { Task { await finishVoice() } })
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        }
      }
      .padding(.trailing, hasText ? 10 : 2)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
      ActionButton(kind: (working && !canSend) ? .stop : .send, enabled: working && !canSend ? !stopping : canSend, busy: stopping, label: actionLabel) {
        if working && !canSend { Task { await stop() } } else { send() }
      }
    }
  }

  private var placeholder: String {
    if blocked { return "Answer the request above first" }
    if working { return "Add a note for the agent…" }
    return "Message \(info?.cli == .codex ? "Codex" : "Claude")"
  }

  private var actionLabel: String {
    if working && !canSend { return "Stop" }
    if working { return when == .interrupt ? "Interrupt and send" : "Send at its next step" }
    return "Send"
  }

  // ---------------------------------------------------------------- actions

  private func send() {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    if atts.isEmpty, let native = Self.native(t) {
      text = ""
      switch native {
      case "model": tray = true
      case "context", "usage", "status", "cost": context = true
      case "clear": error = "To start over, start a new chat from the list."
      default: break
      }
      return
    }
    let a = atts
    let how: Delivery = working ? when : .send
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    withAnimation(Theme.settle) {
      text = ""
      atts = []
      error = nil
      voiceNote = nil
      when = .next
    }
    Drafts.set(session, "")
    store.submit(session: session, text: t, attachments: a, how: how)
    sent()
  }

  /// The Mac's composer handles these itself rather than sending them to the CLI; here they open the same things.
  static func native(_ t: String) -> String? {
    let m = t.lowercased()
    for n in ["model", "context", "usage", "status", "cost", "clear"] where m == "/\(n)" { return n }
    return nil
  }

  private func stop() async {
    stopping = true
    error = nil
    let r = await store.perform(.stop(session: session))
    stopping = false
    switch r {
    case .success(let res) where res.ok: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    case .success(let res): error = res.error ?? "Your Mac refused to stop the chat."
    case .failure(let e): error = e.localizedDescription
    }
  }

  private func edit(_ n: LiveNote) {
    Task {
      if let e = await store.note(session, n.id, .cancel) {
        error = e
        return
      }
      UISelectionFeedbackGenerator().selectionChanged()
      text = text.isEmpty ? n.text : "\(n.text)\n\(text)"
      focused = true
    }
  }

  /// A note the turn didn't use: send it as a message now.
  private func resend(_ n: LiveNote) {
    dismissed.insert(n.id)
    store.submit(session: session, text: n.text, attachments: [], how: working ? .next : .send)
    sent()
  }

  private func pick(_ c: ChatMeta.Command) {
    UISelectionFeedbackGenerator().selectionChanged()
    if c.kind == "app" {
      text = "/\(c.name)"
      send()
      return
    }
    text = "/\(c.name) "
    focused = true
  }

  private func switchModel(_ m: String) async {
    switching = m
    if let e = await store.setModel(session, m) {
      error = e
      UINotificationFeedbackGenerator().notificationOccurred(.error)
    } else {
      UISelectionFeedbackGenerator().selectionChanged()
    }
    // The Mac's view says the model once the CLI took it; until then the chip shows the choice in progress.
    try? await Task.sleep(for: .seconds(4))
    switching = nil
  }

  private func startVoice() {
    error = nil
    focused = false
    Task {
      if let e = await voice.start() { error = e }
    }
  }

  private func finishVoice() async {
    guard let audio = voice.finish() else { return }
    voice.phase = .transcribing
    do {
      let r = try await store.transcribe(audio, session: session)
      voice.phase = .idle
      if r.heard != "words" || r.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        error = r.heard == "silence" ? "Didn't hear anything. Hold the microphone and speak." : "Didn't catch any words. Try again a little closer."
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        return
      }
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      withAnimation(Theme.settle) {
        text = text.isEmpty ? r.text : "\(text) \(r.text)"
        voiceNote = "Transcribed on your Mac. Check it, then send."
      }
    } catch {
      voice.phase = .idle
      self.error = error.localizedDescription
    }
  }
}

// ---------------------------------------------------------------- the send / stop button

struct ActionButton: View {
  enum Kind { case send, stop }
  let kind: Kind
  let enabled: Bool
  let busy: Bool
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        if busy {
          ProgressView().tint(Theme.onPrimary)
        } else {
          Image(systemName: kind == .stop ? "stop.fill" : "arrow.up")
            .font(.system(size: kind == .stop ? 14 : 17, weight: .bold))
            .contentTransition(.symbolEffect(.replace.downUp))
        }
      }
      .frame(width: 40, height: 40)
      .foregroundStyle(Theme.onPrimary)
      .background(Theme.primary.opacity(enabled ? 1 : 0.22), in: Circle())
      .scaleEffect(enabled ? 1 : 0.92)
    }
    .buttonStyle(PressStyle())
    .disabled(!enabled)
    .animation(Theme.morph, value: kind)
    .animation(Theme.morph, value: enabled)
    .accessibilityLabel(label)
    .accessibilityIdentifier(kind == .stop ? "chat.stop" : "chat.send")
  }
}

/// While the agent works: does the message go in at its next step (the Mac's Enter) or interrupt it (⌘Enter)?
struct WhenToggle: View {
  @Binding var when: Delivery
  var body: some View {
    HStack(spacing: 6) {
      option(.next, "At its next step", "arrow.turn.down.right")
      option(.interrupt, "Interrupt now", "bolt.fill")
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.when")
  }

  private func option(_ d: Delivery, _ t: String, _ icon: String) -> some View {
    let on = when == d
    return Button {
      UISelectionFeedbackGenerator().selectionChanged()
      withAnimation(Theme.settle) { when = d }
    } label: {
      Label(t, systemImage: icon).labelStyle(TightLabel())
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .foregroundStyle(on ? Theme.onPrimary : Theme.dim)
        .background(on ? Theme.primary : Theme.raised, in: Capsule())
    }
    .buttonStyle(PressStyle())
    .accessibilityAddTraits(on ? .isSelected : [])
    .accessibilityIdentifier("chat.when|\(d.rawValue)")
  }
}

// ---------------------------------------------------------------- queued notes

/// The chat's notes as the Mac's strip shows them (queued: deliver now, edit, remove; unused after the turn: send or
/// dismiss), plus this phone's notes still on their way.
struct NotesStrip: View {
  let session: String
  let notes: [LiveNote]
  let pending: [Outgoing]
  let working: Bool
  let edit: (LiveNote) -> Void
  let dismiss: (String) -> Void
  let resend: (LiveNote) -> Void
  @Environment(RemoteStore.self) private var store

  var body: some View {
    let queued = notes.filter { $0.state == "queued" }
    let unused = notes.filter { $0.state == "unused" }
    if !queued.isEmpty || !pending.isEmpty || !unused.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        if !queued.isEmpty || !pending.isEmpty {
          HStack(spacing: 6) {
            Pulse(color: Theme.working, size: 5)
            Text(queued.count + pending.count > 1 ? "\(queued.count + pending.count) queued" : "Queued").font(.caption.weight(.semibold)).foregroundStyle(Theme.working)
            Text("· goes in at the next step").font(.caption).foregroundStyle(Theme.faint)
          }
        }
        ForEach(queued) { n in
          row(n.text, atts: n.atts ?? 0) {
            Button { Task { if let e = await store.note(session, n.id, .now) { _ = e } else { UIImpactFeedbackGenerator(style: .medium).impactOccurred() } } } label: {
              Label("Now", systemImage: "bolt.fill").labelStyle(TightLabel()).font(.caption.weight(.semibold))
            }
            .accessibilityLabel("Deliver now: interrupt the current step")
            .accessibilityIdentifier("note.now|\(n.id)")
            Button { edit(n) } label: { Image(systemName: "pencil") }
              .accessibilityLabel("Edit")
              .accessibilityIdentifier("note.edit|\(n.id)")
            Button { Task { _ = await store.note(session, n.id, .cancel) } } label: { Image(systemName: "xmark") }
              .accessibilityLabel("Remove")
              .accessibilityIdentifier("note.remove|\(n.id)")
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("note|\(n.id)|queued")
          .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
        ForEach(pending) { o in
          row(o.text, atts: o.attachments.count) {
            switch o.state {
            case .failed:
              Button { store.retry(o) } label: { Label("Retry", systemImage: "arrow.clockwise").labelStyle(TightLabel()).font(.caption.weight(.semibold)) }
                .foregroundStyle(Theme.error)
              Button { store.discard(o) } label: { Image(systemName: "xmark") }
            default:
              ProgressView().controlSize(.mini)
            }
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("note|\(o.id)|\(o.state == .sending ? "sending" : "sent")")
          .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
        if !unused.isEmpty {
          HStack(spacing: 8) {
            Text(unused.count == 1 ? "1 note wasn't used" : "\(unused.count) notes weren't used").font(.caption).foregroundStyle(Theme.dim)
            Spacer(minLength: 4)
            Button("Send now") { unused.forEach(resend) }.font(.caption.weight(.semibold)).accessibilityIdentifier("note.unused.send")
            Button("Dismiss") { unused.forEach { dismiss($0.id) } }.font(.caption).foregroundStyle(Theme.faint)
          }
          .padding(.horizontal, 4)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("notes.strip")
      .animation(Theme.settle, value: notes)
      .animation(Theme.settle, value: pending)
    }
  }

  private func row<B: View>(_ text: String, atts: Int, @ViewBuilder _ buttons: () -> B) -> some View {
    HStack(spacing: 10) {
      Text(text).font(.subheadline).foregroundStyle(Theme.text).lineLimit(2)
      if atts > 0 { Label("\(atts)", systemImage: "paperclip").labelStyle(TightLabel()).font(.caption).foregroundStyle(Theme.dim) }
      Spacer(minLength: 4)
      HStack(spacing: 14) { buttons() }.font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim).buttonStyle(.plain)
    }
    .padding(.leading, 12).padding(.trailing, 12).padding(.vertical, 8)
    .background(Theme.working.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.working.opacity(0.22), lineWidth: 0.5))
  }
}

// ---------------------------------------------------------------- the chat's state, above the bar

struct MetaRow: View {
  let meta: ChatMeta?
  let info: SessionInfo?
  let switching: String?
  let model: (String) -> Void
  let mode: () -> Void
  let context: () -> Void
  let commands: () -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        modelChip
        if let m = meta?.mode {
          chip(action: mode) {
            Image(systemName: "lock.fill").imageScale(.small)
            Text(meta?.modeLabel ?? m)
          }
          .accessibilityIdentifier("meta.mode|\(m)")
        }
        if meta != nil {
          chip(action: context) {
            ContextRing(used: meta?.context, window: meta?.window).frame(width: 13, height: 13)
            Text(tokens(meta?.context))
          }
          .accessibilityIdentifier("meta.context")
        }
        if let l = meta?.ladder {
          chip(action: context) {
            Image(systemName: "stairs").imageScale(.small)
            Text(l.on ? "Ladder\(l.tiers.map { " · \($0.joined(separator: " → "))" } ?? "")" : "Ladder off")
          }
          .accessibilityIdentifier("meta.ladder|\(l.on)")
        }
        if let c = meta?.commands, !c.isEmpty {
          chip(action: commands) { Text("/").fontWeight(.bold); Text("Commands") }
            .accessibilityIdentifier("meta.commands")
        }
      }
      .padding(.horizontal, 2)
    }
    .frame(height: 30)
  }

  @ViewBuilder private var modelChip: some View {
    let current = switching ?? meta?.model ?? info?.model ?? ""
    let list = meta?.models ?? []
    if !current.isEmpty || !list.isEmpty {
      if let locked = meta?.modelLocked, !locked.isEmpty {
        chip(action: {}) {
          Image(systemName: "cpu").imageScale(.small)
          Text(label(current, list))
        }
        .disabled(true)
        .accessibilityHint(locked)
        .accessibilityIdentifier("meta.model")
      } else {
        Menu {
          Section("Model for this chat") {
            ForEach(list) { m in
              Button { model(m.id) } label: { if m.id == current { Label(m.label, systemImage: "checkmark") } else { Text(m.label) } }
                .accessibilityIdentifier("meta.model|\(m.id)")
            }
          }
        } label: {
          chipLabel {
            Image(systemName: "cpu").imageScale(.small)
            Text(label(current, list))
            if switching != nil { ProgressView().controlSize(.mini) }
            Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(Theme.faint)
          }
        }
        .disabled(list.isEmpty)
        .accessibilityIdentifier("meta.model")
      }
    }
  }

  private func label(_ id: String, _ list: [StartOptions.Choice]) -> String {
    list.first { $0.id == id }?.label ?? (id.isEmpty ? "Model" : modelName(id))
  }

  private func chip<C: View>(action: @escaping () -> Void, @ViewBuilder _ c: () -> C) -> some View {
    Button(action: action) { chipLabel(c) }.buttonStyle(PressStyle())
  }

  private func chipLabel<C: View>(@ViewBuilder _ c: () -> C) -> some View {
    HStack(spacing: 5) { c() }
      .font(.caption.weight(.medium)).foregroundStyle(Theme.dim).lineLimit(1)
      .padding(.horizontal, 10).frame(height: 28)
      .background(Theme.raised, in: Capsule())
  }
}

func tokens(_ n: Double?) -> String {
  guard let n, n > 0 else { return "0" }
  return n >= 1_000_000 ? String(format: "%.1fM", n / 1_000_000) : n >= 1000 ? "\(Int((n / 1000).rounded()))k" : "\(Int(n))"
}

/// How full the context window is.
struct ContextRing: View {
  let used: Double?
  let window: Double?
  var body: some View {
    let f = min(1, max(0, (used ?? 0) / max(1, window ?? 200_000)))
    ZStack {
      Circle().stroke(Theme.border, lineWidth: 2)
      Circle().trim(from: 0, to: f).stroke(f > 0.85 ? Theme.error : f > 0.6 ? Theme.needs : Theme.working, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
    }
  }
}

// ---------------------------------------------------------------- attachments

/// What's picked for the next message: pictures as thumbnails, files as chips; each removable.
struct AttachStrip: View {
  @Binding var atts: [Attachment]
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(Array(atts.enumerated()), id: \.element.id) { i, a in
          ZStack(alignment: .topTrailing) {
            if let img = a.image {
              Image(uiImage: img).resizable().scaledToFill().frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
              HStack(spacing: 8) {
                Image(systemName: a.ext == "pdf" ? "doc.richtext" : "doc.text").font(.title3).foregroundStyle(Theme.dim)
                VStack(alignment: .leading, spacing: 1) {
                  Text(a.name).font(.caption.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                  Text(a.sizeLabel).font(.caption2).foregroundStyle(Theme.faint)
                }
              }
              .padding(.horizontal, 10).frame(maxWidth: 170, minHeight: 60, maxHeight: 60, alignment: .leading)
              .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
            }
            Button { _ = withAnimation(Theme.settle) { atts.remove(at: i) } } label: {
              Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
            }
            .offset(x: 6, y: -6)
            .accessibilityLabel("Remove \(a.name)")
            .accessibilityIdentifier("attach.remove|\(i)")
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier(a.kind == .image ? "attach.pic|\(i)" : "attach.file|\(i)")
          .transition(.scale(scale: 0.8).combined(with: .opacity))
        }
      }
      .padding(.top, 6).padding(.horizontal, 2)
    }
  }
}

/// Where pictures and files come from: the photo library, the camera, Files, the clipboard; under test, invented ones.
struct AttachSources: View {
  @Binding var atts: [Attachment]
  @Binding var error: String?
  var done: () -> Void = {}
  @State private var picking = false
  @State private var camera = false
  @State private var files = false
  @State private var items: [PhotosPickerItem] = []

  private var room: Int { max(0, Remote.maxAttach - atts.count) }

  var body: some View {
    HStack(spacing: 10) {
      source("Photos", "photo.on.rectangle", "attach.library") { picking = true }
      if UIImagePickerController.isSourceTypeAvailable(.camera) { source("Camera", "camera", "attach.camera") { camera = true } }
      source("Files", "doc", "attach.files") { files = true }
      source("Paste", "doc.on.clipboard", "attach.paste") { paste() }
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--e2e-image") {
          source("Test picture", "circle.fill", "attach.test") { add(Attachment(image: testPicture(), name: "Test picture")) }
        }
        if let p = Demo.arg("--e2e-file"), let d = FileManager.default.contents(atPath: p) {
          source("Test file", "doc.text", "attach.testfile") { addFile(d, (p as NSString).lastPathComponent) }
        }
      #endif
    }
    .disabled(room == 0)
    .photosPicker(isPresented: $picking, selection: $items, maxSelectionCount: max(1, room), matching: .images)
    .onChange(of: items) { _, new in
      Task {
        for it in new {
          if let d = try? await it.loadTransferable(type: Data.self), let img = UIImage(data: d) { add(Attachment(image: img, name: "Photo")) }
        }
        items = []
      }
    }
    .fullScreenCover(isPresented: $camera) { CameraPicker { if let i = $0 { add(Attachment(image: i, name: "Photo")) } }.ignoresSafeArea() }
    .fileImporter(isPresented: $files, allowedContentTypes: [.pdf, .text, .plainText, .sourceCode, .json, .commaSeparatedText, .xml, .yaml, .html], allowsMultipleSelection: true) { r in
      guard case .success(let urls) = r else { return }
      for u in urls.prefix(room) {
        let ok = u.startAccessingSecurityScopedResource()
        defer { if ok { u.stopAccessingSecurityScopedResource() } }
        guard let d = try? Data(contentsOf: u) else { continue }
        addFile(d, u.lastPathComponent)
      }
    }
  }

  private func add(_ a: Attachment) {
    guard atts.count < Remote.maxAttach else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    withAnimation(Theme.settle) { atts.append(a) }
    done()
  }

  private func addFile(_ d: Data, _ name: String) {
    if let why = Attachment.refusal(file: d) {
      error = "\(name): \(why)"
      return
    }
    add(Attachment(file: d, name: name))
  }

  private func paste() {
    let pb = UIPasteboard.general
    if let img = pb.image {
      add(Attachment(image: img, name: "Pasted picture"))
    } else if let s = pb.string, let d = s.data(using: .utf8) {
      add(Attachment(file: d, name: "Pasted text.txt"))
    } else {
      error = "Nothing to paste."
    }
  }

  private func source(_ t: String, _ icon: String, _ id: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 6) {
        Image(systemName: icon).font(.title3).frame(width: 52, height: 52).background(Theme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        Text(t).font(.caption).lineLimit(1)
      }
      .foregroundStyle(Theme.text)
      .frame(maxWidth: .infinity)
    }
    .buttonStyle(PressStyle())
    .accessibilityIdentifier(id)
  }
}

// ---------------------------------------------------------------- the tray

/// "+": pictures and files, then the chat's model, mode, context and commands.
struct Tray: View {
  @Binding var atts: [Attachment]
  let meta: ChatMeta?
  let info: SessionInfo?
  @Binding var error: String?
  let model: (String) -> Void
  let commands: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          AttachSources(atts: $atts, error: $error) { dismiss() }
          Text("Up to \(Remote.maxAttach) per message: pictures, PDFs and text files up to \(Remote.maxUpload / 1_000_000) MB each.").font(.caption).foregroundStyle(Theme.faint)
          if let list = meta?.models, !list.isEmpty {
            SectionTitle("Model")
            if let l = meta?.modelLocked, !l.isEmpty { Text(l).font(.footnote).foregroundStyle(Theme.dim) }
            VStack(spacing: 0) {
              ForEach(list) { m in
                Button {
                  model(m.id)
                  dismiss()
                } label: {
                  HStack {
                    Text(m.label).foregroundStyle(Theme.text)
                    Text(m.id == m.label ? "" : m.id).font(.caption.monospaced()).foregroundStyle(Theme.faint)
                    Spacer()
                    if m.id == meta?.model { Image(systemName: "checkmark").foregroundStyle(Theme.text) }
                  }
                  .padding(.vertical, 11).padding(.horizontal, 14).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .disabled(!(meta?.modelLocked ?? "").isEmpty)
                .accessibilityIdentifier("tray.model|\(m.id)")
              }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
          if let m = meta?.mode {
            SectionTitle("Permission mode")
            HStack(spacing: 10) {
              Image(systemName: "lock.fill").foregroundStyle(Theme.faint)
              VStack(alignment: .leading, spacing: 2) {
                Text(meta?.modeLabel ?? m).foregroundStyle(Theme.text)
                Text("Change it on the Mac. A running chat's mode can't be changed from the phone.").font(.caption).foregroundStyle(Theme.faint)
              }
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityIdentifier("tray.mode")
          }
          if meta != nil {
            SectionTitle("Context")
            ContextSummary(meta: meta)
          }
          if let c = meta?.commands, !c.isEmpty {
            Button(action: commands) {
              HStack {
                Text("/").font(.body.weight(.bold).monospaced())
                Text("Slash commands")
                Spacer()
                Text("\(c.count)").foregroundStyle(Theme.faint)
                Image(systemName: "chevron.right").foregroundStyle(Theme.faint)
              }
              .foregroundStyle(Theme.text).padding(14)
              .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("tray.commands")
          }
        }
        .padding(16)
      }
      .background(Theme.bg)
      .navigationTitle("Add to the message")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

struct ContextSummary: View {
  let meta: ChatMeta?
  var body: some View {
    let used = meta?.context ?? 0, window = meta?.window ?? 0
    HStack(spacing: 14) {
      ContextRing(used: used, window: window > 0 ? window : nil).frame(width: 34, height: 34)
      VStack(alignment: .leading, spacing: 2) {
        Text(window > 0 ? "\(tokens(used)) of \(tokens(window)) tokens" : "\(tokens(used)) tokens").font(.body.monospacedDigit()).foregroundStyle(Theme.text)
        Text(window > 0 ? "\(Int((used / window * 100).rounded()))% of the context window used by the last request" : "Context used by the last request").font(.caption).foregroundStyle(Theme.faint)
        if let l = meta?.ladder {
          Text(l.on ? "Ladder on\(l.tiers.map { ": \($0.joined(separator: " → "))" } ?? "")" : "Ladder off").font(.caption).foregroundStyle(Theme.dim)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(14)
    .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("context.summary")
  }
}

struct ContextSheet: View {
  let meta: ChatMeta?
  let info: SessionInfo?
  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 14) {
        ContextSummary(meta: meta)
        if let m = meta?.model { Label("Model: \(modelName(m))", systemImage: "cpu").font(.footnote).foregroundStyle(Theme.dim) }
        if let m = meta?.mode { Label("Mode: \(meta?.modeLabel ?? m) (change it on the Mac)", systemImage: "lock.fill").font(.footnote).foregroundStyle(Theme.dim) }
        Spacer()
      }
      .padding(16)
      .background(Theme.bg)
      .navigationTitle("Context")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

// ---------------------------------------------------------------- slash commands

private func rank(_ c: ChatMeta.Command, _ q: String) -> Int {
  if q.isEmpty { return 1 }
  let n = c.name.lowercased(), q = q.lowercased()
  if n == q { return 4 }
  if n.hasPrefix(q) { return 3 }
  if n.contains(q) { return 2 }
  return (c.description ?? "").lowercased().contains(q) ? 1 : 0
}

/// Typing "/": the CLI's commands that match, above the field.
struct SlashList: View {
  static func matches(_ commands: [ChatMeta.Command], _ query: String) -> [ChatMeta.Command] {
    var scored: [(ChatMeta.Command, Int)] = []
    for c in commands {
      let r = rank(c, query)
      if r > 0 { scored.append((c, r)) }
    }
    scored.sort { a, b in a.1 != b.1 ? a.1 > b.1 : a.0.name < b.0.name }
    return Array(scored.prefix(30).map { $0.0 })
  }

  let commands: [ChatMeta.Command]
  let query: String
  let pick: (ChatMeta.Command) -> Void
  var body: some View {
    let m = Self.matches(commands, query)
    if !m.isEmpty {
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(m) { c in CommandRow(c: c) { pick(c) } }
        }
      }
      .frame(maxHeight: 210)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
      .accessibilityIdentifier("slash.list")
    }
  }
}

struct CommandRow: View {
  let c: ChatMeta.Command
  let pick: () -> Void
  var body: some View {
    Button(action: pick) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("/\(c.name)").font(.subheadline.monospaced().weight(.medium)).foregroundStyle(Theme.text)
        if let h = c.hint, !h.isEmpty { Text(h).font(.caption.monospaced()).foregroundStyle(Theme.faint).lineLimit(1) }
        Text(c.description ?? "").font(.caption).foregroundStyle(Theme.dim).lineLimit(1)
        Spacer(minLength: 4)
        if let k = c.kind, k != "command" {
          Text(k == "app" ? "in app" : k).font(.caption2.weight(.semibold)).foregroundStyle(Theme.dim)
            .padding(.horizontal, 6).padding(.vertical, 2).background(Theme.raised, in: Capsule())
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(c.kind == "terminal")
    .opacity(c.kind == "terminal" ? 0.45 : 1)
    .accessibilityIdentifier("slash|\(c.name)")
  }
}

struct CommandsSheet: View {
  let commands: [ChatMeta.Command]
  let cli: String?
  let pick: (ChatMeta.Command) -> Void
  @State private var q = ""
  var body: some View {
    NavigationStack {
      List {
        ForEach(commands.filter { rank($0, q) > 0 }) { c in
          CommandRow(c: c) { pick(c) }.listRowInsets(EdgeInsets()).listRowBackground(Theme.card)
        }
      }
      .listStyle(.plain)
      .searchable(text: $q, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search commands")
      .navigationTitle(cli == "codex" ? "Codex commands" : "Claude Code commands")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

/// A model id as people say it: "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-5-5[1m]" -> "Haiku 5.5 [1m]".
/// Ids of other shapes (Codex's "gpt-6.1-sol", aliases) come back unchanged.
func modelName(_ id: String) -> String {
  guard id.hasPrefix("claude-") else { return id }
  var rest = String(id.dropFirst("claude-".count))
  var suffix = ""
  if let b = rest.firstIndex(of: "[") { suffix = " " + rest[b...]; rest = String(rest[..<b]) }
  let parts = rest.split(separator: "-").map(String.init)
  guard let family = parts.first, !family.isEmpty, family.allSatisfy(\.isLetter) else { return id }
  let version = parts.dropFirst().prefix { $0.allSatisfy(\.isNumber) && $0.count <= 2 }
  guard !version.isEmpty else { return id }
  return family.prefix(1).uppercased() + family.dropFirst() + " " + version.joined(separator: ".") + suffix
}
