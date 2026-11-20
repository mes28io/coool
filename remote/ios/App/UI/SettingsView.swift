import RemoteProtocol
import SwiftUI

struct SettingsView: View {
  @Environment(RemoteStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @AppStorage("haptics") private var haptics = true
  @AppStorage("sound") private var sound = false
  @State private var confirmUnpair = false

  var body: some View {
    NavigationStack {
      Form {
        if let m = store.mac {
          Section {
            row("Status", store.macOnline() ? "Online" : "Offline, last seen \(ago(store.macLastSeen))")
            row("This iPhone's name", m.name)
            row("Paired", Date(timeIntervalSince1970: TimeInterval(m.pairedAt) / 1000).formatted(date: .abbreviated, time: .shortened))
            row("Relay", URL(string: m.relay)?.host() ?? m.relay)
            row("Mac id", String(m.macId.prefix(8)))
          } header: { Text("This Mac") }
            .listRowBackground(Theme.card)
        }

        Section {
          Toggle("Haptic", isOn: $haptics).accessibilityIdentifier("settings.haptics")
          Toggle("Sound", isOn: $sound).accessibilityIdentifier("settings.sound")
        } header: { Text("When an agent needs you") } footer: {
          Text("Only while the app is open. coool Remote sends no push notifications.")
        }
        .listRowBackground(Theme.card)

        Section {
          Button("Unpair this iPhone", role: .destructive) { confirmUnpair = true }
            .accessibilityIdentifier("settings.unpair")
        } footer: {
          Text("Forgets the Mac and this iPhone's keys. Remove the iPhone on the Mac too, in Settings > Remote.")
        }
        .listRowBackground(Theme.card)

        Section {
          HStack {
            Wordmark(size: 22)
            Text("Remote").font(.title3.weight(.semibold)).foregroundStyle(Theme.dim)
            Spacer()
            Text("\(Bundle.main.version) · protocol \(Remote.version)").font(.footnote).foregroundStyle(Theme.faint)
          }
          Text("Messages between this iPhone and your Mac are end to end encrypted: the relay stores and forwards sealed messages it can't read. No account, no analytics, no other network calls.")
            .font(.footnote).foregroundStyle(Theme.dim)
          Text("Open source: github.com/mes28io/coool").font(.footnote).foregroundStyle(Theme.faint)
        } header: { Text("About") }
          .listRowBackground(Theme.card)
      }
      .scrollContentBackground(.hidden)
      .background(Theme.bg)
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("settings.done") } }
      .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
        Button("Unpair", role: .destructive) {
          dismiss()
          store.unpair()
        }
      } message: {
        Text("You'll need to scan a new code from your Mac to use Remote again.")
      }
    }
  }

  private func row(_ k: String, _ v: String) -> some View {
    LabeledContent(k) { Text(v).foregroundStyle(Theme.dim).multilineTextAlignment(.trailing) }
  }
}

extension Bundle {
  var version: String { (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0" }
}
