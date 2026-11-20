// Pieces of the chat view: sub-agents fanning out, one item of the live view, pictures and files to send.

import PhotosUI
import RemoteProtocol
import SwiftUI

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

/// One item of the live view.
struct LiveItemView: View, Equatable {
  let item: LiveItem
  let session: String
  let running: Bool
  @State private var open = false

  static func == (a: LiveItemView, b: LiveItemView) -> Bool { a.item == b.item && a.session == b.session && a.running == b.running }

  var body: some View {
    switch item.role {
    case "user":
      UserBubble(text: item.text, images: item.images ?? [], files: [], steer: item.steer == true, session: session, status: nil)
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
