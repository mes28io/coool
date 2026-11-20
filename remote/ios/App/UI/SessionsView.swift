import RemoteProtocol
import SwiftUI

enum Route: Hashable {
  case session(String)
  case need(String)
}

struct SessionsView: View {
  @Environment(RemoteStore.self) private var store
  @State private var path: [Route] = []
  @State private var newChat = false
  @State private var settings = false

  var body: some View {
    NavigationStack(path: $path) {
      List {
        Section { MacStatusRow() }

        if !store.needs.isEmpty {
          Section {
            ForEach(store.needs) { n in
              NavigationLink(value: Route.need(n.id)) { NeedRow(need: n, title: store.sessions[n.session]?.title) }
                .listRowBackground(Theme.card)
                .accessibilityIdentifier("need|\(n.id)|\(n.session)|\(n.tool)")
            }
          } header: {
            HStack(spacing: 6) {
              Text("Needs you")
              if !store.unseen.isEmpty {
                Text("\(store.unseen.count) new")
                  .font(.caption2.weight(.bold)).foregroundStyle(Theme.needsInk)
                  .padding(.horizontal, 6).padding(.vertical, 2)
                  .background(Theme.needs, in: Capsule())
                  .accessibilityLabel("\(store.unseen.count) new")
                  .accessibilityIdentifier("needs.badge")
              }
            }
          }
        }

        ForEach(store.groups, id: \.project) { g in
          Section {
            ForEach(g.sessions) { s in
              NavigationLink(value: Route.session(s.id)) { SessionRow(session: s, status: store.status(of: s)) }
                .listRowBackground(Theme.card)
                .accessibilityIdentifier("session|\(s.id)|\(s.project)")
            }
          } header: {
            Label(g.project, systemImage: "folder").textCase(nil).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.dim)
          }
        }

        if store.sessions.isEmpty && store.live {
          Section {
            Text("No sessions on your Mac yet. Start a chat with the button at the top.")
              .font(.callout).foregroundStyle(Theme.faint)
          }
          .listRowBackground(Theme.card)
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(Theme.bg)
      .refreshable { await store.refresh() }
      .navigationTitle("Sessions")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { settings = true } label: { Image(systemName: "gearshape") }
            .accessibilityLabel("Settings").accessibilityIdentifier("toolbar.settings")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button { newChat = true } label: { Image(systemName: "square.and.pencil") }
            .accessibilityLabel("New chat").accessibilityIdentifier("toolbar.new")
        }
      }
      .navigationDestination(for: Route.self) { r in
        switch r {
        case .session(let id): ChatView(sessionId: id)
        case .need(let id): NeedView(needId: id) { session in
            // After an answer, go to the chat it came from.
            path = [.session(session)]
          }
        }
      }
      .sheet(isPresented: $newChat) {
        NewChatView { session in
          newChat = false
          path = [.session(session)]
        }
      }
      .sheet(isPresented: $settings) { SettingsView() }
    }
  }
}

struct MacStatusRow: View {
  @Environment(RemoteStore.self) private var store

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { ctx in
      let online = store.macOnline(now: ctx.date)
      HStack(spacing: 12) {
        Image(systemName: "laptopcomputer")
          .font(.title3).foregroundStyle(Theme.dim).frame(width: 28).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(title(online)).font(.body.weight(.medium)).foregroundStyle(Theme.text)
          Text(detail(online, ctx.date)).font(.footnote).foregroundStyle(Theme.faint)
        }
        Spacer()
        Circle().fill(online ? Theme.done : Theme.faint.opacity(0.5)).frame(width: 9, height: 9).accessibilityHidden(true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("mac.status")
      .accessibilityValue(online ? "online" : "offline")
    }
    .listRowBackground(Theme.card)
  }

  private func title(_ online: Bool) -> String {
    if !store.live && store.macLastSeen == nil { return store.connError == nil ? "Connecting" : "Not connected" }
    return online ? "Your Mac is online" : "Your Mac is offline"
  }

  private func detail(_ online: Bool, _ now: Date) -> String {
    if let e = store.connError, !store.live { return e }
    if online {
      let working = store.sessions.values.filter { $0.state == "working" }.count
      var parts: [String] = []
      if working > 0 { parts.append("\(working) working") }
      if !store.needs.isEmpty { parts.append("\(store.needs.count) need\(store.needs.count == 1 ? "s" : "") you") }
      return parts.isEmpty ? "Live" : parts.joined(separator: " · ")
    }
    return "Last seen \(ago(store.macLastSeen, now: now)). Nothing runs from here until coool is open again."
  }
}

struct SessionRow: View {
  let session: SessionInfo
  let status: Status

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      StatusDot(status: status).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
      VStack(alignment: .leading, spacing: 3) {
        Text(session.title.isEmpty ? "Untitled" : session.title)
          .font(.body).foregroundStyle(session.state == "ended" ? Theme.dim : Theme.text).lineLimit(2)
        HStack(spacing: 6) {
          Text(status.label).foregroundStyle(status.textColor)
          Text("·").foregroundStyle(Theme.faint)
          Image(systemName: session.cli.glyph).imageScale(.small).foregroundStyle(Theme.faint)
          Text(session.cli.label).foregroundStyle(Theme.faint)
          if session.lastActivity > 0 {
            Text("·").foregroundStyle(Theme.faint)
            Text(ago(Int64(session.lastActivity))).foregroundStyle(Theme.faint)
          }
        }
        .font(.footnote)
        .lineLimit(1)
      }
    }
    .padding(.vertical, 3)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(session.title), \(status.label), \(session.cli.label)")
  }
}

struct NeedRow: View {
  let need: Need
  let title: String?

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: need.icon)
        .font(.body.weight(.semibold)).foregroundStyle(Theme.needsInk)
        .frame(width: 30, height: 30).background(Theme.needs, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(need.headline).font(.body.weight(.medium)).foregroundStyle(Theme.text)
        Text(need.command ?? need.questions.first?.question ?? need.summary)
          .font(need.command != nil ? .footnote.monospaced() : .footnote).foregroundStyle(Theme.dim).lineLimit(2)
        if let title { Text(title).font(.caption).foregroundStyle(Theme.faint).lineLimit(1) }
      }
    }
    .padding(.vertical, 3)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Needs you: \(need.headline). \(need.command ?? need.summary)")
  }
}

extension Need {
  var headline: String {
    switch kind {
    case "question": "A question for you"
    case "plan": "A plan to approve"
    default: tool == "Bash" ? "Wants to run a command" : "Wants to use \(tool)"
    }
  }
  var icon: String {
    switch kind {
    case "question": "questionmark"
    case "plan": "list.bullet"
    default: tool == "Bash" ? "terminal" : "hand.raised"
    }
  }
}
