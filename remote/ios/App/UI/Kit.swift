// Small pieces the screens share: the live motion (a breathing dot, the step ticker), rings for usage and progress,
// chips, tool glyphs, the elapsed clock, and words for times. Calm motion; Reduce Motion turns it off.

import RemoteProtocol
import SwiftUI

extension Theme {
  static let workingSoft = working.opacity(0.14)
  static let needsSoft = needs.opacity(0.18)
  static let doneSoft = done.opacity(0.16)
  static let spring = Animation.spring(response: 0.42, dampingFraction: 0.86)
  /// Rows arriving and settling, the composer's controls changing: quick, no overshoot, interruptible.
  static let settle = Animation.spring(response: 0.32, dampingFraction: 0.9)
  /// The send / stop button morphing: a touch of bounce.
  static let morph = Animation.spring(response: 0.28, dampingFraction: 0.72)
  static let mono = Font.system(.footnote, design: .monospaced)
}

/// A dot that breathes while something works: the session feels alive without moving anything else.
struct Pulse: View {
  var color: Color = Theme.working
  var size: CGFloat = 8
  @State private var on = false
  @Environment(\.accessibilityReduceMotion) private var reduce

  var body: some View {
    ZStack {
      Circle().fill(color.opacity(0.28)).frame(width: size * 2.2, height: size * 2.2).scaleEffect(on ? 1 : 0.45).opacity(on ? 0 : 0.9)
      Circle().fill(color).frame(width: size, height: size)
    }
    .frame(width: size * 2.2, height: size * 2.2)
    .onAppear {
      guard !reduce else { return }
      withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { on = true }
    }
    .accessibilityHidden(true)
  }
}

/// Text that a soft highlight sweeps across: the step in progress.
struct Ticker: View {
  let text: String
  var font: Font = .footnote
  var color: Color = Theme.working
  @State private var phase: CGFloat = -1
  @Environment(\.accessibilityReduceMotion) private var reduce

  var body: some View {
    Text(text)
      .font(font)
      .foregroundStyle(color)
      .lineLimit(1)
      .overlay {
        if !reduce {
          GeometryReader { g in
            LinearGradient(colors: [.clear, Theme.bg.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
              .frame(width: g.size.width * 0.35)
              .offset(x: phase * g.size.width)
              .blendMode(.normal)
          }
          .mask(Text(text).font(font).lineLimit(1))
          .allowsHitTesting(false)
        }
      }
      .contentTransition(.opacity)
      .animation(Theme.calm, value: text)
      .onAppear {
        guard !reduce else { return }
        withAnimation(.linear(duration: 2.2).repeatForever(autoreverses: false)) { phase = 1.2 }
      }
  }
}

/// A ring from 0 to 1: usage windows, a sub-agent's share of the turn.
struct Ring: View {
  let value: Double
  var color: Color
  var width: CGFloat = 5
  var body: some View {
    ZStack {
      Circle().stroke(Theme.raised, lineWidth: width)
      Circle().trim(from: 0, to: max(0.02, min(1, value))).stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round)).rotationEffect(.degrees(-90))
    }
    .animation(Theme.spring, value: value)
  }
}

struct Chip: View {
  let text: String
  var icon: String? = nil
  var tint: Color = Theme.dim
  var fill: Color = Theme.raised
  var body: some View {
    HStack(spacing: 4) {
      if let icon { Image(systemName: icon).imageScale(.small) }
      Text(text).lineLimit(1)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(tint)
    .padding(.horizontal, 8).padding(.vertical, 4)
    .background(fill, in: Capsule())
  }
}

/// A tool's glyph and plain name: what kind of step it is, at a glance.
enum ToolLook {
  static func icon(_ tool: String?) -> String {
    switch (tool ?? "").lowercased() {
    case "bash", "shell", "exec_command", "local_shell", "command_execution": "terminal"
    case "edit", "multiedit", "str_replace_based_edit_tool", "apply_patch", "patch", "notebookedit": "pencil"
    case "write": "doc.badge.plus"
    case "read", "view": "doc.text"
    case "grep", "glob", "search", "ls", "find": "magnifyingglass"
    case "webfetch", "websearch": "globe"
    case "task", "agent": "person.2"
    case "todowrite": "checklist"
    case let t where t.hasPrefix("mcp__coool-device__browser") || t.hasPrefix("browser_"): "safari"
    case let t where t.hasPrefix("mcp__coool-device__sim") || t.hasPrefix("sim_"): "iphone"
    case let t where t.hasPrefix("mcp__coool-device__mac") || t.hasPrefix("mac_"): "desktopcomputer"
    default: "wrench.and.screwdriver"
    }
  }

  /// "Edit · src/a.rs" -> ("Edit", "src/a.rs").
  static func split(_ s: String) -> (String, String) {
    if let r = s.range(of: " · ") { return (String(s[..<r.lowerBound]), String(s[r.upperBound...])) }
    return (s, "")
  }

  static func change(_ kind: String) -> String {
    switch kind {
    case "edit": "pencil"
    case "create": "doc.badge.plus"
    case "delete": "trash"
    case "move": "arrow.right.doc.on.clipboard"
    case "commit": "checkmark.circle"
    case "push": "arrow.up.circle"
    case "merge": "arrow.triangle.merge"
    case "pr": "arrow.triangle.pull"
    case "publish", "deploy": "paperplane"
    default: "circle"
    }
  }
}

/// "3:07" since `start` (epoch ms), ticking each second.
struct Elapsed: View {
  let since: Double
  var font: Font = .footnote.monospacedDigit()
  var color: Color = Theme.faint
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      Text(elapsed(since, ctx.date)).font(font).foregroundStyle(color)
    }
  }
}

func elapsed(_ since: Double, _ now: Date = Date()) -> String {
  let s = max(0, Int(now.timeIntervalSince1970 - since / 1000))
  if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) }
  return String(format: "%d:%02d", s / 60, s % 60)
}

/// "in 2 h", "in 3 d": until a usage window resets.
func until(_ ms: Double?, _ now: Date = Date()) -> String? {
  guard let ms else { return nil }
  let s = Int(ms / 1000 - now.timeIntervalSince1970)
  if s <= 0 { return "now" }
  if s < 3600 { return "in \(max(1, s / 60)) min" }
  if s < 86400 { return "in \(s / 3600) h" }
  return "in \(s / 86400) d"
}

/// A section title: small, calm, with an optional trailing piece.
struct SectionTitle<Trailing: View>: View {
  let text: String
  @ViewBuilder var trailing: Trailing
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.dim)
      Spacer()
      trailing
    }
    .padding(.horizontal, 4)
    .accessibilityAddTraits(.isHeader)
  }
}

extension SectionTitle where Trailing == EmptyView {
  init(_ text: String) {
    self.text = text
    self.trailing = EmptyView()
  }
}

/// A calm empty state: a glyph, a line, a hint.
struct EmptyState: View {
  let icon: String
  let title: String
  let hint: String
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: icon).font(.system(size: 34, weight: .light)).foregroundStyle(Theme.faint)
      Text(title).font(.headline).foregroundStyle(Theme.text)
      Text(hint).font(.callout).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 36).padding(.horizontal, 24)
    .accessibilityElement(children: .combine)
  }
}

/// The page's plain card, for scroll views (the List cards are `Card`).
extension View {
  func tile(stroke: Color? = nil, padding: CGFloat = 14) -> some View {
    self.padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(stroke ?? Theme.border, lineWidth: stroke == nil ? 0.5 : 1.2))
  }
}
