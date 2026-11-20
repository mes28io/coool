// Home: reads at a glance. How many agents work, need you, are done; what needs you; plan usage; per project, the
// sessions with the step each is on, the Changes ledger, files two sessions edit, the commit trail; then earlier
// sessions. Mission control on the Mac is the model, in a phone's form: one column, the urgent first.

import RemoteProtocol
import SwiftUI

enum Route: Hashable {
  case session(String)
  case need(String)
  case device(String, String)
}

enum Filter: String, CaseIterable, Identifiable {
  case all, working, needs, done
  var id: String { rawValue }
  var label: String {
    switch self {
    case .all: "All"
    case .working: "Working"
    case .needs: "Needs you"
    case .done: "Done"
    }
  }
  func admits(_ s: Status) -> Bool {
    switch self {
    case .all: true
    case .working: s == .working
    case .needs: s == .needsYou
    case .done: s == .waiting || s == .done
    }
  }
}

struct SessionsView: View {
  @Environment(RemoteStore.self) private var store
  @State private var path: [Route] = {
    #if DEBUG
      // Screenshots: open a chat straight away (`--open chat:4`).
      if let id = Demo.arg("--open") { return [.session(id)] }
    #endif
    return []
  }()
  @State private var newChat = false
  @State private var settings = false
  @State private var filter: Filter = .all
  @State private var project: String?
  @State private var query = ""
  @State private var duplicate: RemoteStore.Recent?

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          MacStatusRow()
          if store.phase == .paired, !store.macOnline(), store.macLastSeen != nil {
            OfflineNote()
          }
          PulseStrip(filter: $filter)
          if !store.needs.isEmpty && (filter == .all || filter == .needs) { needs }
          if let u = store.overview?.usage, !u.isEmpty, filter == .all, query.isEmpty { UsageStrip(usage: u) }
          FilterBar(filter: $filter, project: $project, projects: projectNames)
          projectsList
          if !earlier.isEmpty && (filter == .all || filter == .done) { earlierList }
          if store.sessions.isEmpty && store.live {
            EmptyState(icon: "sparkles", title: "No sessions yet", hint: "Start a chat from here with the pencil above, or on your Mac.")
          } else if store.sessions.isEmpty {
            EmptyState(icon: "antenna.radiowaves.left.and.right", title: "Reaching your Mac", hint: "Sessions appear here as soon as your Mac answers.")
          }
          if !store.recents.isEmpty && query.isEmpty && filter == .all { recentPrompts }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 32)
        .animation(Theme.spring, value: filter)
        .animation(Theme.spring, value: project)
      }
      .background(Theme.bg)
      .refreshable { await store.refresh() }
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search sessions")
      .navigationTitle("coool")
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
        case .need(let id):
          NeedView(needId: id) { session in
            // After an answer, go to the chat it came from.
            path = [.session(session)]
          }
        case .device(let s, let d): DeviceView(sessionId: s, device: d)
        }
      }
      .sheet(isPresented: $newChat) {
        NewChatView(seed: nil) { session in
          newChat = false
          path = [.session(session)]
        }
      }
      .sheet(item: $duplicate) { r in
        NewChatView(seed: r) { session in
          duplicate = nil
          path = [.session(session)]
        }
      }
      .sheet(isPresented: $settings) { SettingsView() }
    }
  }

  // ---------------------------------------------------------------- pieces

  private var visible: [SessionInfo] {
    store.sessions.values.filter { s in
      filter.admits(store.status(of: s))
        && (project == nil || s.project == project)
        && (query.isEmpty || s.title.localizedCaseInsensitiveContains(query) || s.project.localizedCaseInsensitiveContains(query))
    }
  }

  private var projectNames: [String] { Array(Set(store.sessions.values.map(\.project))).sorted() }

  private var earlier: [SessionInfo] { visible.filter { $0.state == "ended" }.sorted { $0.lastActivity > $1.lastActivity }.prefix(8).map { $0 } }

  private var needs: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle(text: "Needs you") {
        if !store.unseen.isEmpty {
          Text("\(store.unseen.count) new")
            .font(.caption2.weight(.bold)).foregroundStyle(Theme.needsInk)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Theme.needs, in: Capsule())
            .accessibilityLabel("\(store.unseen.count) new")
            .accessibilityIdentifier("needs.badge")
        }
      }
      ForEach(store.needs) { n in
        NavigationLink(value: Route.need(n.id)) {
          NeedRow(need: n, title: store.session(n.session)?.title)
            .tile(stroke: Theme.needs.opacity(0.7))
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("need|\(n.id)|\(n.session)|\(n.tool)")
        .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
  }

  private var projectsList: some View {
    let live = visible.filter { $0.state != "ended" }
    let groups = Dictionary(grouping: live, by: \.project)
    let needing = Set(store.needs.map(\.session))
    func rank(_ p: String) -> Int {
      let ss = groups[p] ?? []
      if ss.contains(where: { needing.contains($0.id) || $0.state == "waiting" }) { return 0 }
      if ss.contains(where: { $0.state == "working" }) { return 1 }
      return 2
    }
    let order = groups.keys.sorted { a, b in (rank(a), a) < (rank(b), b) }
    return ForEach(order, id: \.self) { p in
      ProjectCard(name: p, sessions: (groups[p] ?? []).sorted { $0.lastActivity > $1.lastActivity }, view: store.overview?.projects.first { $0.name == p })
        .transition(.opacity)
    }
  }

  private var earlierList: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle("Earlier")
      VStack(spacing: 0) {
        ForEach(Array(earlier.enumerated()), id: \.element.id) { i, s in
          if i > 0 { Divider().overlay(Theme.border).padding(.leading, 40) }
          NavigationLink(value: Route.session(s.id)) { SessionRow(session: s, status: store.status(of: s)).padding(.vertical, 10).padding(.horizontal, 14) }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("session|\(s.id)|\(s.project)")
        }
      }
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
    }
  }

  private var recentPrompts: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle("Started from this iPhone")
      VStack(spacing: 0) {
        ForEach(Array(store.recents.prefix(4).enumerated()), id: \.element.id) { i, r in
          if i > 0 { Divider().overlay(Theme.border).padding(.leading, 14) }
          Button { duplicate = r } label: {
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 3) {
                Text(r.text).font(.callout).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
                Text("\(r.projectName) · \(r.cli.label)\(r.model.map { " · \($0)" } ?? "")").font(.caption).foregroundStyle(Theme.faint)
              }
              Spacer(minLength: 8)
              Image(systemName: "plus.square.on.square").foregroundStyle(Theme.dim)
            }
            .padding(.vertical, 10).padding(.horizontal, 14)
            .contentShape(Rectangle())
          }
          .buttonStyle(PressStyle())
          .accessibilityLabel("Start again: \(r.text)")
          .accessibilityIdentifier("recent|\(i)")
        }
      }
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
    }
  }
}

/// A press that answers the finger: a slight dip, no flash.
struct PressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
      .opacity(configuration.isPressed ? 0.85 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// Three numbers that answer "what's going on": working, needs you, done. Each filters the page.
struct PulseStrip: View {
  @Binding var filter: Filter
  @Environment(RemoteStore.self) private var store

  var body: some View {
    let all = store.sessions.values.filter { $0.state != "ended" }
    let working = all.filter { store.status(of: $0) == .working }.count
    let needs = Set(store.needs.map(\.session)).union(all.filter { $0.state == "waiting" }.map(\.id)).count
    let done = all.filter { store.status(of: $0) == .waiting }.count
    HStack(spacing: 10) {
      tile(.working, working, "Working", Theme.working)
      tile(.needs, needs, "Need you", Theme.needs)
      tile(.done, done, "Done", Theme.done)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("home.pulse")
  }

  private func tile(_ f: Filter, _ n: Int, _ label: String, _ c: Color) -> some View {
    let on = filter == f
    return Button {
      UISelectionFeedbackGenerator().selectionChanged()
      filter = on ? .all : f
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          if f == .working && n > 0 { Pulse(color: c, size: 7) } else { Circle().fill(n > 0 ? c : Theme.faint.opacity(0.4)).frame(width: 7, height: 7).frame(width: 15, height: 15) }
          Spacer(minLength: 0)
        }
        Text("\(n)").font(.system(.largeTitle, design: .rounded).weight(.semibold)).foregroundStyle(Theme.text).contentTransition(.numericText()).monospacedDigit()
        Text(label).font(.footnote.weight(.medium)).foregroundStyle(n > 0 ? (f == .needs ? Theme.needsText : f == .done ? Theme.doneText : Theme.working) : Theme.faint).lineLimit(1).minimumScaleFactor(0.8)
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(on ? c.opacity(0.16) : Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(on ? c.opacity(0.8) : Theme.border, lineWidth: on ? 1.2 : 0.5))
      .animation(Theme.spring, value: n)
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel("\(n) \(label)")
    .accessibilityAddTraits(on ? .isSelected : [])
    .accessibilityIdentifier("pulse.\(f.rawValue)")
  }
}

struct FilterBar: View {
  @Binding var filter: Filter
  @Binding var project: String?
  let projects: [String]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(Filter.allCases) { f in
          Button {
            UISelectionFeedbackGenerator().selectionChanged()
            filter = f
          } label: {
            Text(f.label).font(.footnote.weight(.medium))
              .padding(.horizontal, 12).padding(.vertical, 7)
              .foregroundStyle(filter == f ? Theme.onPrimary : Theme.text)
              .background(filter == f ? Theme.primary : Theme.card, in: Capsule())
              .overlay(Capsule().strokeBorder(filter == f ? .clear : Theme.border, lineWidth: 0.5))
          }
          .buttonStyle(PressStyle())
          .accessibilityAddTraits(filter == f ? .isSelected : [])
          .accessibilityIdentifier("filter.\(f.rawValue)")
        }
        if projects.count > 1 {
          Menu {
            Button("All projects") { project = nil }
            ForEach(projects, id: \.self) { p in Button(p) { project = p } }
          } label: {
            HStack(spacing: 4) {
              Image(systemName: "folder").imageScale(.small)
              Text(project ?? "Project").lineLimit(1)
              Image(systemName: "chevron.down").imageScale(.small)
            }
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 12).padding(.vertical, 7)
            .foregroundStyle(project == nil ? Theme.text : Theme.onPrimary)
            .background(project == nil ? Theme.card : Theme.primary, in: Capsule())
            .overlay(Capsule().strokeBorder(project == nil ? Theme.border : .clear, lineWidth: 0.5))
          }
          .accessibilityIdentifier("filter.project")
        }
      }
      .padding(.horizontal, 2)
    }
  }
}

/// Plan usage as rings: the Mac's usage ring, per window.
struct UsageStrip: View {
  let usage: [String: Overview.Usage]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle("Usage")
      VStack(spacing: 0) {
        ForEach(Array(usage.keys.sorted().enumerated()), id: \.element) { i, k in
          if let u = usage[k] {
            if i > 0 { Divider().overlay(Theme.border) }
            HStack(alignment: .center, spacing: 10) {
              VStack(alignment: .leading, spacing: 1) {
                Text(k == "claude" ? "Claude" : "Codex").font(.footnote.weight(.semibold)).foregroundStyle(Theme.text)
                if let p = u.plan { Text(p).font(.caption).foregroundStyle(Theme.faint).lineLimit(1) }
              }
              .frame(minWidth: 56, alignment: .leading)
              Spacer(minLength: 0)
              HStack(spacing: 14) {
                ForEach(u.windows.prefix(2), id: \.self) { w in
                  let pct = (w.percent ?? 0) / 100
                  HStack(spacing: 8) {
                    ZStack {
                      Ring(value: pct, color: pct >= 0.9 ? Theme.error : pct >= 0.7 ? Theme.needs : Theme.text.opacity(0.75), width: 4)
                      Text("\(Int((w.percent ?? 0).rounded()))").font(.caption2.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.text)
                    }
                    .frame(width: 34, height: 34)
                    VStack(alignment: .leading, spacing: 1) {
                      Text(short(w.label)).font(.caption.weight(.medium)).foregroundStyle(Theme.dim).lineLimit(1).fixedSize()
                      if let r = until(w.resets) { Text(r).font(.caption2).foregroundStyle(Theme.faint).lineLimit(1).fixedSize() }
                    }
                  }
                  .accessibilityElement(children: .ignore)
                  .accessibilityLabel("\(k == "claude" ? "Claude" : "Codex") \(w.label): \(Int((w.percent ?? 0).rounded())) percent used")
                }
              }
            }
            .padding(.vertical, 10)
          }
        }
      }
      .padding(.horizontal, 14)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
    }
    .accessibilityIdentifier("home.usage")
  }

  private func short(_ l: String) -> String {
    let t = l.replacingOccurrences(of: "Current ", with: "")
    return t.prefix(1).uppercased() + t.dropFirst()
  }
}

/// One project: its live sessions with what each does now, files two sessions edit, the Changes ledger, commits.
struct ProjectCard: View {
  let name: String
  let sessions: [SessionInfo]
  let view: Overview.ProjectView?
  @Environment(RemoteStore.self) private var store
  @State private var allChanges = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "folder.fill").foregroundStyle(Theme.faint).imageScale(.small).accessibilityHidden(true)
        Text(name).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
        if let b = view?.branch { Chip(text: b, icon: "arrow.triangle.branch") }
        Spacer(minLength: 0)
      }
      .accessibilityAddTraits(.isHeader)
      VStack(spacing: 0) {
        ForEach(Array(sessions.enumerated()), id: \.element.id) { i, s in
          if i > 0 { Divider().overlay(Theme.border).padding(.leading, 30) }
          NavigationLink(value: Route.session(s.id)) {
            LiveSessionRow(session: s, status: store.status(of: s), agents: view?.agents?.first { $0.session == s.id }?.agents ?? [])
              .padding(.vertical, 10)
          }
          .buttonStyle(PressStyle())
          .accessibilityIdentifier("session|\(s.id)|\(s.project)")
        }
      }
      if let o = view?.overlaps, !o.isEmpty {
        ForEach(o, id: \.self) { x in
          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.needs).imageScale(.small)
            VStack(alignment: .leading, spacing: 2) {
              Text("\(x.sessions.count) sessions edit ").font(.footnote).foregroundStyle(Theme.text) + Text(x.file).font(Theme.mono).foregroundStyle(Theme.text)
              if let t = x.titles, !t.isEmpty { Text(t.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.faint).lineLimit(2) }
            }
          }
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.needsSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("overlap|\(x.file)")
        }
      }
      if let cs = view?.changes, !cs.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text("Changes").font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim)
            Spacer()
            if cs.count > 4 {
              Button(allChanges ? "Less" : "All \(cs.count)") { withAnimation(Theme.spring) { allChanges.toggle() } }
                .font(.footnote.weight(.medium)).foregroundStyle(Theme.dim)
            }
          }
          ForEach(cs.prefix(allChanges ? cs.count : 4), id: \.self) { c in ChangeRow(change: c) }
        }
        .accessibilityIdentifier("ledger|\(name)")
      }
      if let cm = view?.commits, !cm.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          Text("Commits").font(.footnote.weight(.semibold)).foregroundStyle(Theme.dim).padding(.bottom, 6)
          ForEach(Array(cm.prefix(4).enumerated()), id: \.element) { i, c in
            HStack(alignment: .top, spacing: 10) {
              VStack(spacing: 0) {
                Circle().fill(i == 0 ? Theme.text : Theme.faint).frame(width: 7, height: 7).padding(.top, 5)
                if i < min(cm.count, 4) - 1 { Rectangle().fill(Theme.border).frame(width: 1.5).frame(maxHeight: .infinity) }
              }
              .frame(width: 8)
              VStack(alignment: .leading, spacing: 1) {
                Text(c.subject).font(.footnote).foregroundStyle(Theme.text).lineLimit(2)
                Text("\(c.short) · \(ago(Int64(c.ts)))\(c.files.map { " · \($0) file\($0 == 1 ? "" : "s")" } ?? "")").font(.caption2.monospaced()).foregroundStyle(Theme.faint)
              }
              .padding(.bottom, 8)
            }
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("commits|\(name)")
      }
    }
    .tile()
  }
}

struct ChangeRow: View {
  let change: Overview.Change
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: ToolLook.change(change.kind)).font(.footnote).foregroundStyle(Theme.dim).frame(width: 18)
      (Text(change.action).foregroundStyle(Theme.dim) + Text(" ") + Text(change.object).font(Theme.mono).foregroundStyle(Theme.text))
        .font(.footnote).lineLimit(1).truncationMode(.middle)
      if let t = change.times, t > 1 { Text("×\(t)").font(.caption.monospacedDigit()).foregroundStyle(Theme.faint) }
      Spacer(minLength: 4)
      Text(ago(Int64(change.ts))).font(.caption2).foregroundStyle(Theme.faint)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A live session: its state, the step it's on (ticking), sub-agents fanning out, the turn's clock.
struct LiveSessionRow: View {
  let session: SessionInfo
  let status: Status
  var agents: [Overview.AgentRow] = []

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Group {
        if status == .working { Pulse(color: Theme.working, size: 7) } else { StatusDot(status: status) }
      }
      .frame(width: 18, height: 18)
      VStack(alignment: .leading, spacing: 4) {
        Text(session.title.isEmpty ? "Untitled" : session.title)
          .font(.body).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
        if status == .working, let step = session.step {
          let (tool, target) = ToolLook.split(step)
          HStack(spacing: 6) {
            Image(systemName: ToolLook.icon(tool)).imageScale(.small).foregroundStyle(Theme.working)
            Ticker(text: target.isEmpty ? tool : "\(tool) \(target)", font: .footnote)
          }
          .accessibilityIdentifier("session.step")
        }
        HStack(spacing: 6) {
          Text(status.label).foregroundStyle(status.textColor)
          if status == .working, let t = session.turnStarted {
            Text("·").foregroundStyle(Theme.faint)
            Elapsed(since: t, font: .footnote.monospacedDigit())
          }
          if let n = session.steps, n > 0, status == .working {
            Text("·").foregroundStyle(Theme.faint)
            Text("\(n) step\(n == 1 ? "" : "s")").foregroundStyle(Theme.faint)
          }
          Text("·").foregroundStyle(Theme.faint)
          Text(session.cli.label).foregroundStyle(Theme.faint)
        }
        .font(.footnote).lineLimit(1)
        if !agents.isEmpty {
          VStack(alignment: .leading, spacing: 3) {
            ForEach(agents.prefix(3), id: \.self) { a in
              HStack(spacing: 6) {
                Rectangle().fill(Theme.working.opacity(0.5)).frame(width: 1.5, height: 14)
                Image(systemName: "person.2").imageScale(.small).foregroundStyle(Theme.working)
                Text(a.label).font(.caption).foregroundStyle(Theme.dim).lineLimit(1)
                if let s = a.step { Text(ToolLook.split(s).0).font(.caption2).foregroundStyle(Theme.faint).lineLimit(1) }
              }
            }
            if agents.count > 3 { Text("+\(agents.count - 3) more agents").font(.caption2).foregroundStyle(Theme.faint).padding(.leading, 8) }
          }
          .padding(.top, 2)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint.opacity(0.7)).padding(.top, 4)
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(session.title), \(status.label)\(session.step.map { ", \($0)" } ?? ""), \(session.cli.label)")
  }
}

struct OfflineNote: View {
  @Environment(RemoteStore.self) private var store
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "moon.zzz").foregroundStyle(Theme.dim)
      Text("Your Mac is asleep or coool is closed. What you see is from \(ago(store.macLastSeen)); nothing you send runs until it's back.")
        .font(.footnote).foregroundStyle(Theme.dim)
    }
    .tile(padding: 12)
    .accessibilityIdentifier("home.offline")
  }
}

struct MacStatusRow: View {
  @Environment(RemoteStore.self) private var store

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { ctx in
      let online = store.macOnline(now: ctx.date)
      HStack(spacing: 8) {
        if online && store.live { Pulse(color: Theme.done, size: 6) } else { Circle().fill(Theme.faint.opacity(0.5)).frame(width: 7, height: 7).frame(width: 14, height: 14) }
        Text(title(online)).font(.footnote.weight(.medium)).foregroundStyle(Theme.dim)
        Text(detail(online, ctx.date)).font(.footnote).foregroundStyle(Theme.faint).lineLimit(1)
        Spacer(minLength: 0)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("mac.status")
      .accessibilityValue(online ? "online" : "offline")
    }
  }

  private func title(_ online: Bool) -> String {
    if !store.live && store.macLastSeen == nil { return store.connError == nil ? "Connecting" : "Not connected" }
    return online ? "Mac online" : "Mac offline"
  }

  private func detail(_ online: Bool, _ now: Date) -> String {
    if let e = store.connError, !store.live { return e }
    if online { return "· live" }
    return "· seen \(ago(store.macLastSeen, now: now))"
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
          .font(.body).foregroundStyle(session.state == "ended" ? Theme.dim : Theme.text).lineLimit(2).multilineTextAlignment(.leading)
        HStack(spacing: 6) {
          Text(status.label).foregroundStyle(status.textColor)
          Text("·").foregroundStyle(Theme.faint)
          Text(session.project).foregroundStyle(Theme.faint)
          if session.lastActivity > 0 {
            Text("·").foregroundStyle(Theme.faint)
            Text(ago(Int64(session.lastActivity))).foregroundStyle(Theme.faint)
          }
        }
        .font(.footnote)
        .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .contentShape(Rectangle())
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
        .frame(width: 32, height: 32).background(Theme.needs, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline) {
          Text(need.headline).font(.body.weight(.semibold)).foregroundStyle(Theme.text)
          Spacer(minLength: 4)
          if need.risk != nil { Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Theme.error).accessibilityLabel("Risky") }
        }
        Text(need.line)
          .font(need.command != nil || need.diff != nil ? .footnote.monospaced() : .footnote).foregroundStyle(Theme.dim).lineLimit(2).multilineTextAlignment(.leading)
        if let title { Text(title).font(.caption).foregroundStyle(Theme.faint).lineLimit(1) }
      }
      Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint.opacity(0.7)).padding(.top, 6)
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Needs you: \(need.headline). \(need.line)\(need.risk.map { ". Risk: \($0)" } ?? "")")
  }
}

extension Need {
  var headline: String {
    if let w = what, !w.isEmpty { return w }
    switch kind {
    case "question": return "A question for you"
    case "plan": return "Approve a plan"
    default:
      if diff != nil { return tool == "Write" ? "Create a file" : "Edit a file" }
      return tool == "Bash" ? "Run a command" : "Use \(tool)"
    }
  }
  var line: String {
    if let c = command { return c }
    if kind == "question" { return questions.first?.question ?? summary }
    if kind == "plan", let p = plan { return p.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: "# ")) } ?? summary }
    if let d = diff { return d.path }
    return summary
  }
  var icon: String {
    switch kind {
    case "question": "questionmark"
    case "plan": "list.bullet.rectangle"
    default: diff != nil ? "pencil" : tool == "Bash" ? "terminal" : "hand.raised"
    }
  }
}
