import RemoteProtocol
import SwiftUI

/// One pending request: what is asked, and the only answers a phone may give (allow once, deny, the question's
/// options). "Always allow" and mode changes stay on the Mac.
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

  private var need: Need? { store.needs.first { $0.id == needId } ?? kept }
  private var gone: Bool { !store.needs.contains { $0.id == needId } }

  var body: some View {
    ScrollView {
      if let need {
        VStack(alignment: .leading, spacing: 16) {
          request(need)
          if let done {
            Label(done, systemImage: "checkmark.circle.fill").font(.body.weight(.medium)).foregroundStyle(Theme.doneText)
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
        .padding(20)
      }
    }
    .background(Theme.bg)
    .navigationTitle(need?.kind == "question" ? "Question" : "Request")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      kept = need
      store.markSeen(needId)
    }
  }

  @ViewBuilder private func request(_ n: Need) -> some View {
    let session = store.sessions[n.session]
    Card(stroke: Theme.needs) {
      HStack(spacing: 10) {
        Image(systemName: n.icon).font(.body.weight(.semibold)).foregroundStyle(Theme.needsInk)
          .frame(width: 32, height: 32).background(Theme.needs, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(n.headline).font(.headline).foregroundStyle(Theme.text)
          if let session {
            Text("\(session.title) · \(session.project)").font(.footnote).foregroundStyle(Theme.faint).lineLimit(2)
          }
        }
        Spacer(minLength: 0)
        Text(n.tool).font(.caption.weight(.medium)).foregroundStyle(Theme.dim)
          .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.raised, in: Capsule())
      }
      if let cmd = n.command {
        Text(cmd)
          .font(.callout.monospaced()).foregroundStyle(Theme.text)
          .textSelection(.enabled)
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .accessibilityLabel("Command: \(cmd)")
          .accessibilityIdentifier("need.command")
      } else if n.kind != "question", !n.summary.isEmpty {
        Text(n.summary).font(n.kind == "plan" ? .body : .callout.monospaced()).foregroundStyle(Theme.text).textSelection(.enabled)
      }
      if let e = n.explanation, !e.isEmpty {
        (Text("The agent says: ").foregroundStyle(Theme.faint) + Text(e).foregroundStyle(Theme.dim))
          .font(.subheadline)
          .accessibilityIdentifier("need.explanation")
      }
      if let r = n.risk, !r.isEmpty {
        Label(r, systemImage: "exclamationmark.triangle").font(.footnote.weight(.medium)).foregroundStyle(Theme.error)
      }
    }
  }

  @ViewBuilder private func answers(_ n: Need) -> some View {
    if n.kind == "question" {
      ForEach(Array(n.questions.enumerated()), id: \.offset) { i, q in
        VStack(alignment: .leading, spacing: 8) {
          Text(q.question).font(.body.weight(.medium)).foregroundStyle(Theme.text)
          ForEach(q.options, id: \.self) { o in
            let on = picks[i]?.contains(o) ?? false
            Button {
              var s = picks[i] ?? []
              if q.multi { if on { s.remove(o) } else { s.insert(o) } } else { s = on ? [] : [o] }
              picks[i] = s
            } label: {
              HStack {
                Image(systemName: on ? (q.multi ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multi ? "square" : "circle"))
                  .foregroundStyle(on ? Theme.text : Theme.faint)
                Text(o).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
                Spacer()
              }
              .padding(12)
              .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Theme.text.opacity(0.5) : Theme.border, lineWidth: on ? 1.2 : 0.5))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
            .accessibilityIdentifier("need.option|\(o)")
          }
          if q.allowOther {
            TextField("Or type an answer", text: Binding(get: { other[i] ?? "" }, set: { other[i] = $0 }), axis: .vertical)
              .padding(12).background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
    } else {
      HStack(spacing: 10) {
        Button { Task { await answer(n, .allowOnce) } } label: { busyLabel(n.kind == "plan" ? "Approve" : "Allow once", "allow") }
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
    default: "answer"
    }
    busy = key
    error = nil
    kept = n
    let r = await store.perform(.answer(need: n.id, c))
    busy = nil
    switch r {
    case .success(let res) where res.ok:
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      withAnimation(Theme.calm) {
        done = switch c {
        case .allowOnce: n.kind == "plan" ? "Approved" : "Allowed once"
        case .deny: "Denied"
        default: "Answered"
        }
      }
      try? await Task.sleep(for: .seconds(0.8))
      answered(n.session)
    case .success(let res):
      error = res.error.map { "Your Mac refused: \($0)" } ?? "Your Mac refused the answer."
    case .failure(let e):
      error = e.localizedDescription
    }
  }
}
