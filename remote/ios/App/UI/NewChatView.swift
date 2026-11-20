import RemoteProtocol
import SwiftUI

/// Starting a chat: a project from the Mac's own list (never a path), a CLI, the prompt. The Mac picks the mode,
/// always one that asks.
struct NewChatView: View {
  let started: (String) -> Void
  @Environment(RemoteStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var project: Project?
  @State private var cli: Cli = .claude
  @State private var prompt = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          if store.projects.isEmpty {
            Text("Your Mac hasn't shared any project folders yet. Open a folder in coool on the Mac first.")
              .font(.callout).foregroundStyle(Theme.faint)
          }
          ForEach(store.projects) { p in
            Button {
              project = p
            } label: {
              HStack {
                Label(p.name, systemImage: "folder").foregroundStyle(Theme.text)
                Spacer()
                if project == p { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.text) }
              }
            }
            .accessibilityAddTraits(project == p ? .isSelected : [])
            .accessibilityIdentifier("new.project|\(p.name)")
          }
        } header: { Text("Project") }
          .listRowBackground(Theme.card)

        Section {
          Picker("Agent", selection: $cli) {
            ForEach(Cli.allCases, id: \.self) { c in Label(c.label, systemImage: c.glyph).tag(c) }
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("new.cli")
        } header: { Text("Agent") }
          .listRowBackground(Theme.card)

        Section {
          TextField("What should it do?", text: $prompt, axis: .vertical)
            .lineLimit(4...10)
            .accessibilityLabel("Prompt")
            .accessibilityIdentifier("new.prompt")
        } header: { Text("Prompt") } footer: {
          Text("The chat starts in a mode that asks before it runs commands. Bypass and full access can only be chosen on the Mac.")
        }
        .listRowBackground(Theme.card)

        if let error {
          Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Theme.error).accessibilityIdentifier("new.error") }
            .listRowBackground(Theme.card)
        }
      }
      .scrollContentBackground(.hidden)
      .background(Theme.bg)
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if busy {
            ProgressView()
          } else {
            Button("Start") { Task { await start() } }
              .fontWeight(.semibold)
              .disabled(project == nil || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
              .accessibilityIdentifier("new.start")
          }
        }
      }
      .task { await store.refresh() }
    }
  }

  private func start() async {
    guard let project, store.projects.contains(project) else { return }
    busy = true
    error = nil
    let r = await store.perform(.start(project, cli, text: prompt.trimmingCharacters(in: .whitespacesAndNewlines)))
    busy = false
    switch r {
    case .success(let res) where res.ok:
      guard let s = res.session else { error = "Your Mac started the chat but didn't say which."; return }
      store.startedMode[s] = res.mode ?? ""
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      started(s)
    case .success(let res): error = res.error.map { "Your Mac refused: \($0)" } ?? "Your Mac refused to start the chat."
    case .failure(let e): error = e.localizedDescription
    }
  }
}
