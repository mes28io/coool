import RemoteProtocol
import SwiftUI

@main
struct CooolRemoteApp: App {
  @State private var store: RemoteStore
  @Environment(\.scenePhase) private var scenePhase

  init() {
    #if DEBUG
      let args = ProcessInfo.processInfo.arguments
      if args.contains("--reset") {
        Vault.forget()
        for k in UserDefaults.standard.dictionaryRepresentation().keys where k.hasPrefix("draft.") { UserDefaults.standard.removeObject(forKey: k) }
      }
      if let i = args.firstIndex(of: "--demo"), i + 1 < args.count {
        _store = State(initialValue: Demo.store(args[i + 1]))
        return
      }
    #endif
    _store = State(initialValue: RemoteStore())
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(store)
        .tint(Theme.text)
        .onOpenURL { url in
          // A `coool://pair?...` link opened from the Camera app or elsewhere.
          if store.phase != .paired { store.pair(text: url.absoluteString, name: UserDefaults.standard.string(forKey: "deviceName") ?? "iPhone") }
        }
    }
    .onChange(of: scenePhase, initial: true) { _, p in store.setActive(p == .active) }
  }
}

struct RootView: View {
  @Environment(RemoteStore.self) private var store
  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      switch store.phase {
      case .unpaired: PairingView().transition(.opacity)
      case .claiming: ClaimView().transition(.opacity)
      case .paired: SessionsView().transition(.opacity)
      }
    }
    .animation(Theme.calm, value: store.phase)
  }
}
