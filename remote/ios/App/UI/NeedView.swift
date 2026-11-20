// One pending request, as informative as the Mac's Needs-you page: what it asks in plain words, the risk tag, the
// agent's own explanation and the AI read; an edit's change as a diff; a plan rendered. And the only answers a
// phone may give: allow once or deny; a question's options or typed text; a plan's approve or keep planning (with a
// note). "Always allow" and mode changes stay on the Mac.

import RemoteProtocol
import SwiftUI

struct NeedView: View {
  let needId: String
  let answered: (String) -> Void
  @Environment(RemoteStore.self) private var store
  @State private var busy: String?
  @State private var error: String?
  @State private var done: String?
  @State private var picks: [Int: Set<String>] = [:]
  @State private var other: [Int: String] = [:]
  @State private var kept: Need?
  @State private var note = ""
  @State private var noting = false

  private var need: Need? { store.needs.first { $0.id == needId } ?? kept }
  private var gone: Bool { !store.needs.contains { $0.id == needId } }

  var body: some View {
    ScrollView {
      if let need {
        VStack(alignment: .leading, spacing: 16) {
          request(need)
          if let done {
            Label(done, systemImage: "checkmark.circle.fill").font(.body.weight(.semibold)).foregroundStyle(Theme.doneText)
              .frame(maxWidth: .infinity).padding(.vertical, 8)
              .transition(.scale(scale: 0.9).combined(with: .opacity))
              .accessibilityIdentifier("need.done")
          } else if gone {
            Label("This request was answered or withdrawn on your Mac.", systemImage: "checkmark.circle")
              .foregroundStyle(Theme.dim).accessibilityIdentifier("need.gone")
          } else {
            answers(need)
          }
          if let error {
            Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Theme.error)
              .accessibilityIdentifier("need.error")
          }
        }
        .padding(16)
        .animation(Theme.spring, value: done)
      }
    }
    .background(Theme.bg)
    .navigationTitle(need?.kind == "question" ? "Question" : need?.kind == "plan" ? "Plan" : "Request")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      kept = need
      store.markSeen(needId)
    }
  }

  @ViewBuilder private func request(_ n: Need) -> some View {
    let session = store.session(n.session)
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: n.icon).font(.body.weight(.semibold)).foregroundStyle(Theme.needsInk)
          .frame(width: 34, height: 34).background(Theme.needs, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(n.headline).font(.headline).foregroundStyle(Theme.text)
          if let session {
            Text("\(session.title) · \(session.project)").font(.footnote).foregroundStyle(Theme.faint).lineLimit(2)
          }
        }
        Spacer(minLength: 0)
        Chip(text: n.tool)
      }
      if let r = n.risk, !r.isEmpty {
        Label(r, systemImage: "exclamationmark.triangle.fill")
          .font(.footnote.weight(.semibold)).foregroundStyle(Theme.error)
          .padding(.horizontal, 10).padding(.vertical, 7)
          .background(Theme.error.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .accessibilityIdentifier("need.risk")
      }
      if let cmd = n.command, n.diff == nil {
        Text(cmd)
          .font(.callout.monospaced()).foregroundStyle(Theme.text)
          .textSelection(.enabled)
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .accessibilityLabel("Command: \(cmd)")
          .accessibilityIdentifier("need.command")
      }
      if let d = n.diff { DiffView(diff: d, maxLines: 40) }
      if let p = n.plan {
        MarkdownView(text: p)
          .font(.callout)
          .padding(14)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.raised.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("need.plan")
      } else if n.kind != "question", n.command == nil, n.diff == nil, !n.summary.isEmpty {
        Text(n.summary).font(n.kind == "plan" ? .body : .callout.monospaced()).foregroundStyle(Theme.text).textSelection(.enabled)
      }
      if let e = n.explanation, !e.isEmpty {
        VStack(alignment: .leading, spacing: 3) {
          Text("The agent says").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
          Text(e).font(.subheadline).foregroundStyle(Theme.dim)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("need.explanation")
      }
      if let r = n.read {
        VStack(alignment: .leading, spacing: 6) {
          Label("What this does", systemImage: "sparkle.magnifyingglass").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
          Text(r.what).font(.subheadline).foregroundStyle(Theme.text)
          if !r.why.isEmpty { Text(r.why).font(.subheadline).foregroundStyle(Theme.dim) }
          ForEach(r.check, id: \.self) { c in
            Label(c, systemImage: "checkmark.circle").font(.footnote).foregroundStyle(Theme.dim)
          }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.raised.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("need.read")
      }
    }
    .tile(stroke: Theme.needs)
  }

  @ViewBuilder private func answers(_ n: Need) -> some View {
    if n.kind == "question" {
      ForEach(Array(n.questions.enumerated()), id: \.offset) { i, q in
        VStack(alignment: .leading, spacing: 8) {
          Text(q.question).font(.body.weight(.medium)).foregroundStyle(Theme.text)
          if q.multi { Text("Pick any").font(.caption).foregroundStyle(Theme.faint) }
          ForEach(q.options, id: \.self) { o in
            let on = picks[i]?.contains(o) ?? false
            Button {
              UISelectionFeedbackGenerator().selectionChanged()
              var s = picks[i] ?? []
              if q.multi { if on { s.remove(o) } else { s.insert(o) } } else { s = on ? [] : [o] }
              withAnimation(Theme.calm) { picks[i] = s }
            } label: {
              HStack(spacing: 10) {
                Image(systemName: on ? (q.multi ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multi ? "square" : "circle"))
                  .foregroundStyle(on ? Theme.text : Theme.faint)
                Text(o).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
                Spacer()
              }
              .padding(14)
              .background(on ? Theme.raised : Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(on ? Theme.text.opacity(0.55) : Theme.border, lineWidth: on ? 1.2 : 0.5))
            }
            .buttonStyle(PressStyle())
            .accessibilityAddTraits(on ? .isSelected : [])
            .accessibilityIdentifier("need.option|\(o)")
          }
          if q.allowOther {
            TextField("Or type an answer", text: Binding(get: { other[i] ?? "" }, set: { other[i] = $0 }), axis: .vertical)
              .lineLimit(1...5)
              .padding(14).background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
              .accessibilityIdentifier("need.other|\(i)")
          }
        }
      }
      Button {
        Task { await answer(n, questionChoice(n)) }
      } label: { busyLabel("Answer", "answer") }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(busy != nil || !questionComplete(n))
        .accessibilityIdentifier("need.answer")
      Button { Task { await answer(n, .deny) } } label: { busyLabel("Skip the question", "deny") }
        .buttonStyle(SecondaryButtonStyle()).disabled(busy != nil)
        .accessibilityIdentifier("need.deny")
    } else if n.kind == "plan" {
      Button { Task { await answer(n, .allowOnce) } } label: { busyLabel("Approve the plan", "allow") }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(busy != nil)
        .accessibilityIdentifier("need.allow")
      if noting {
        TextField("What should change?", text: $note, axis: .vertical)
          .lineLimit(2...6)
          .padding(14).background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
          .accessibilityIdentifier("need.note")
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
      Button {
        if noting || !note.isEmpty { Task { await answer(n, .keepPlanning(note: note)) } } else { withAnimation(Theme.spring) { noting = true } }
      } label: { busyLabel(noting ? (note.trimmingCharacters(in: .whitespaces).isEmpty ? "Keep planning" : "Keep planning with this note") : "Keep planning…", "keep") }
        .buttonStyle(SecondaryButtonStyle())
        .disabled(busy != nil)
        .accessibilityIdentifier("need.keep")
      Text("Approving lets it start. Keep planning sends it back to plan, with your note if you write one.")
        .font(.footnote).foregroundStyle(Theme.faint)
    } else {
      HStack(spacing: 10) {
        Button { Task { await answer(n, .allowOnce) } } label: { busyLabel("Allow once", "allow") }
          .buttonStyle(PrimaryButtonStyle())
          .accessibilityIdentifier("need.allow")
        Button { Task { await answer(n, .deny) } } label: { busyLabel("Deny", "deny") }
          .buttonStyle(SecondaryButtonStyle())
          .accessibilityIdentifier("need.deny")
      }
      .disabled(busy != nil)
      Text("From your iPhone you can allow once or deny. To always allow something, use coool on your Mac.")
        .font(.footnote).foregroundStyle(Theme.faint)
    }
  }

  private func busyLabel(_ title: String, _ key: String) -> some View {
    ZStack {
      Text(title).opacity(busy == key ? 0 : 1)
      if busy == key { ProgressView() }
    }
  }

  private func questionComplete(_ n: Need) -> Bool {
    n.questions.indices.allSatisfy { !(picks[$0] ?? []).isEmpty || !(other[$0] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
  }

  private func questionChoice(_ n: Need) -> Choice {
    let all = n.questions.indices.map { i -> [String] in
      let typed = (other[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let picked = n.questions[i].options.filter { picks[i]?.contains($0) ?? false }
      return typed.isEmpty ? picked : picked + [typed]
    }
    if all.count == 1, all[0].count == 1, n.questions[0].options.contains(all[0][0]) { return .option(all[0][0]) }
    return .answers(all)
  }

  private func answer(_ n: Need, _ c: Choice) async {
    let key: String = switch c {
    case .allowOnce: "allow"
    case .deny: "deny"
    case .keepPlanning: "keep"
    default: "answer"
    }
    busy = key
    error = nil
    kept = n
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    let r = await store.perform(.answer(need: n.id, c))
    busy = nil
    switch r {
    case .success(let res) where res.ok:
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      done = switch c {
      case .allowOnce: n.kind == "plan" ? "Approved" : "Allowed once"
      case .deny: "Denied"
      case .keepPlanning: "Sent back to planning"
      default: "Answered"
      }
      try? await Task.sleep(for: .seconds(0.8))
      answered(n.session)
    case .success(let res):
      UINotificationFeedbackGenerator().notificationOccurred(.error)
      error = res.error.map { "Your Mac refused: \($0)" } ?? "Your Mac refused the answer."
    case .failure(let e):
      UINotificationFeedbackGenerator().notificationOccurred(.error)
      error = e.localizedDescription
    }
  }
}
