// Starting a chat: a project from the Mac's own list (never a path; recent ones first), the CLI, the model (what that
// CLI offers on the Mac), a mode among the ones a phone may start in (never Bypass or full access: the Mac refuses
// anything else), the prompt and pictures. A recent prompt can be started again or changed first.

import RemoteProtocol
import SwiftUI

struct NewChatView: View {
  let seed: RemoteStore.Recent?
  let started: (String) -> Void
  @Environment(RemoteStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var project: Project?
  @State private var cli: Cli = .claude
  @State private var model: String?
  @State private var mode: String?
  @State private var prompt = ""
  @State private var pics: [UIImage] = []
  @State private var busy = false
  @State private var error: String?
  @State private var seeded = false

  private var opts: StartOptions.PerCli? { store.options?[cli] }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          section("Project") {
            if store.projects.isEmpty {
              Text("Your Mac hasn't shared any project folders yet. Open a folder in coool on the Mac first.")
                .font(.callout).foregroundStyle(Theme.faint)
            }
            FlowLayout(spacing: 8) {
              ForEach(orderedProjects) { p in
                let on = project == p
                Button {
                  UISelectionFeedbackGenerator().selectionChanged()
                  project = p
                } label: {
                  Label(p.name, systemImage: on ? "folder.fill" : "folder")
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .foregroundStyle(on ? Theme.onPrimary : Theme.text)
                    .background(on ? Theme.primary : Theme.card, in: Capsule())
                    .overlay(Capsule().strokeBorder(on ? .clear : Theme.border, lineWidth: 0.5))
                }
                .buttonStyle(PressStyle())
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("new.project|\(p.name)")
              }
            }
          }

          section("Agent") {
            Picker("Agent", selection: $cli) {
              ForEach(Cli.allCases, id: \.self) { c in Text(c.label).tag(c) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("new.cli")
            .onChange(of: cli) { _, _ in
              model = nil
              mode = opts?.mode
            }
          }

          if let o = opts {
            section("Model") {
              Menu {
                Button { model = nil } label: { check("The Mac's default\(o.model.map { " (\($0))" } ?? "")", model == nil) }
                ForEach(o.models) { m in
                  Button { model = m.id } label: { check(m.label, model == m.id) }
                    .accessibilityIdentifier("new.model|\(m.id)")
                }
              } label: {
                HStack {
                  Image(systemName: "cpu").foregroundStyle(Theme.dim)
                  Text(model.flatMap { id in o.models.first { $0.id == id }?.label } ?? "The Mac's default\(o.model.map { " (\($0))" } ?? "")").foregroundStyle(Theme.text)
                  Spacer()
                  Image(systemName: "chevron.up.chevron.down").foregroundStyle(Theme.faint).imageScale(.small)
                }
                .padding(14).tile(padding: 0)
              }
              .accessibilityIdentifier("new.model")
            }

            section("How it works") {
              VStack(spacing: 0) {
                ForEach(Array(o.modes.enumerated()), id: \.element.id) { i, m in
                  if i > 0 { Divider().overlay(Theme.border).padding(.leading, 44) }
                  let on = (mode ?? o.mode) == m.id
                  Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    mode = m.id
                  } label: {
                    HStack(spacing: 12) {
                      Image(systemName: on ? "largecircle.fill.circle" : "circle").foregroundStyle(on ? Theme.text : Theme.faint)
                      VStack(alignment: .leading, spacing: 1) {
                        Text(m.label).font(.callout).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
                        Text(m.id).font(.caption.monospaced()).foregroundStyle(Theme.faint)
                      }
                      Spacer(minLength: 0)
                    }
                    .padding(.vertical, 11).padding(.horizontal, 14)
                    .contentShape(Rectangle())
                  }
                  .buttonStyle(PressStyle())
                  .accessibilityAddTraits(on ? .isSelected : [])
                  .accessibilityIdentifier("new.mode|\(m.id)")
                }
              }
              .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
              Text("Bypass and full access can only be chosen on the Mac.").font(.footnote).foregroundStyle(Theme.faint)
            }
          }

          section("Prompt") {
            TextField("What should it do?", text: $prompt, axis: .vertical)
              .lineLimit(4...10)
              .padding(14).tile(padding: 0)
              .accessibilityLabel("Prompt")
              .accessibilityIdentifier("new.prompt")
            HStack(spacing: 10) {
              AttachMenu(pics: $pics)
              if pics.isEmpty { Text("Add a picture").font(.footnote).foregroundStyle(Theme.faint) } else { PicStrip(pics: $pics) }
              Spacer(minLength: 0)
            }
          }

          if !store.recents.isEmpty && seed == nil {
            section("Recent prompts") {
              ForEach(Array(store.recents.prefix(5).enumerated()), id: \.element.id) { i, r in
                Button { fill(r) } label: {
                  HStack(spacing: 10) {
                    Image(systemName: "arrow.counterclockwise").foregroundStyle(Theme.faint).imageScale(.small)
                    Text(r.text).font(.footnote).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Text(r.projectName).font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
                  }
                  .padding(.vertical, 6)
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("new.recent|\(i)")
              }
            }
          }

          if let error {
            Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Theme.error).font(.footnote).accessibilityIdentifier("new.error")
          }
          #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--e2e-image") {
              // Test only: asks the Mac for a mode a phone may not use, to see it refused end to end.
              Button("Test: ask for Bypass") { Task { await start(force: "bypassPermissions") } }
                .font(.footnote).foregroundStyle(Theme.faint)
                .accessibilityIdentifier("new.forbidden")
            }
          #endif
        }
        .padding(16)
      }
      .background(Theme.bg)
      .navigationTitle(seed == nil ? "New chat" : "Start again")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if busy {
            ProgressView()
          } else {
            Button("Start") { Task { await start() } }
              .fontWeight(.semibold)
              .disabled(project == nil || (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pics.isEmpty))
              .accessibilityIdentifier("new.start")
          }
        }
      }
      .task {
        if let s = seed, !seeded { fill(s) }
        if mode == nil { mode = opts?.mode }
        await store.refresh()
      }
    }
  }

  private var orderedProjects: [Project] {
    let recent = store.recents.map(\.project)
    return store.projects.sorted { a, b in
      let ia = recent.firstIndex(of: a.id) ?? Int.max, ib = recent.firstIndex(of: b.id) ?? Int.max
      return ia != ib ? ia < ib : a.name < b.name
    }
  }

  private func fill(_ r: RemoteStore.Recent) {
    seeded = true
    prompt = r.text
    cli = r.cli
    project = store.projects.first { $0.id == r.project }
    DispatchQueue.main.async {
      model = r.model
      mode = r.mode
    }
  }

  @ViewBuilder private func check(_ t: String, _ on: Bool) -> some View {
    if on { Label(t, systemImage: "checkmark") } else { Text(t) }
  }

  private func section<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      SectionTitle(title)
      c()
    }
  }

  private func start(force: String? = nil) async {
    guard let project, store.projects.contains(project) else { return }
    busy = true
    error = nil
    defer { busy = false }
    var ids: [String] = []
    if !pics.isEmpty {
      do { ids = try await store.upload(pics) } catch {
        self.error = error.localizedDescription
        return
      }
    }
    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    // Only what the Mac offered; a Mac that sent no options gets the old start (its default model and mode).
    let m = store.options == nil ? nil : model
    let md = force ?? (store.options == nil ? nil : (mode ?? opts?.mode))
    let r = await store.perform(.start(project, cli, text: text, model: m, mode: md, attachments: ids))
    switch r {
    case .success(let res) where res.ok:
      guard let s = res.session else { error = "Your Mac started the chat but didn't say which."; return }
      store.started(s, project: project.name, cli: cli, mode: res.mode ?? "")
      store.remember(.init(text: text, project: project.id, projectName: project.name, cli: cli, model: m, mode: md, at: Date().timeIntervalSince1970))
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      started(s)
    case .success(let res):
      UINotificationFeedbackGenerator().notificationOccurred(.error)
      error = res.error.map { "Your Mac refused: \($0)" } ?? "Your Mac refused to start the chat."
    case .failure(let e): error = e.localizedDescription
    }
  }
}

/// Wraps its children onto lines, left to right.
struct FlowLayout: Layout {
  var spacing: CGFloat = 8
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let w = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
    for s in subviews {
      let d = s.sizeThatFits(.unspecified)
      if x > 0, x + d.width > w { y += line + spacing; x = 0; line = 0 }
      x += d.width + spacing
      widest = max(widest, x - spacing)
      line = max(line, d.height)
    }
    return CGSize(width: min(widest, w), height: y + line)
  }
  func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = b.minX, y = b.minY, line: CGFloat = 0
    for s in subviews {
      let d = s.sizeThatFits(.unspecified)
      if x > b.minX, x + d.width > b.maxX { y += line + spacing; x = b.minX; line = 0 }
      s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(d))
      x += d.width + spacing
      line = max(line, d.height)
    }
  }
}
