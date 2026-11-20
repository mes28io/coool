// coool's look on iOS: near-black and warm off-white, the three state colours (blue working, yellow needs you,
// green done), calm motion. Tokens follow app/src/styles.css; type is the system font, so Dynamic Type works.

import RemoteProtocol
import SwiftUI

extension Color {
  init(light: UInt32, dark: UInt32) {
    self.init(UIColor { t in
      let v = t.userInterfaceStyle == .dark ? dark : light
      return UIColor(red: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    })
  }
}

enum Theme {
  static let bg = Color(light: 0xF7F6F3, dark: 0x171717)
  static let card = Color(light: 0xFFFFFF, dark: 0x212121)
  static let raised = Color(light: 0xF1F0EC, dark: 0x2F2F2F)
  static let border = Color(light: 0xE5E4DF, dark: 0x383838)
  static let text = Color(light: 0x0D0D0D, dark: 0xECECEC)
  static let dim = Color(light: 0x5D5D5D, dark: 0xB4B4B4)
  static let faint = Color(light: 0x8F8F8F, dark: 0x8E8E8E)
  static let working = Color(light: 0x007AFF, dark: 0x0A84FF)
  static let needs = Color(light: 0xFEBC2E, dark: 0xFEBC2E)
  static let needsText = Color(light: 0x9A6700, dark: 0xFEBC2E)
  static let needsInk = Color(light: 0x2B1D00, dark: 0x2B1D00)
  static let done = Color(light: 0x28C840, dark: 0x28C840)
  static let doneText = Color(light: 0x1A7F37, dark: 0x28C840)
  static let error = Color(light: 0xD92D20, dark: 0xFF5F57)
  /// The primary button: off-white on dark, near-black on light (the Mac's "Allow once").
  static let primary = Color(light: 0x0D0D0D, dark: 0xECECEC)
  static let onPrimary = Color(light: 0xFFFFFF, dark: 0x171717)
  static let calm = Animation.easeInOut(duration: 0.25)
}

/// What a session's state means to the person, with its colour.
enum Status: Equatable {
  case working, needsYou, waiting, done

  init(_ s: SessionInfo, hasNeed: Bool) {
    if hasNeed || s.state == "waiting" {
      self = .needsYou
    } else {
      switch s.state {
      case "working": self = .working
      case "idle": self = .waiting
      default: self = .done
      }
    }
  }

  var label: String {
    switch self {
    case .working: "Working"
    case .needsYou: "Needs you"
    case .waiting: "Waiting"
    case .done: "Done"
    }
  }

  var color: Color {
    switch self {
    case .working: Theme.working
    case .needsYou: Theme.needs
    case .waiting: Theme.done
    case .done: Theme.faint
    }
  }

  var textColor: Color {
    switch self {
    case .working: Theme.working
    case .needsYou: Theme.needsText
    case .waiting: Theme.doneText
    case .done: Theme.faint
    }
  }
}

/// The state dot: a ring that turns while working, a filled dot otherwise.
struct StatusDot: View {
  let status: Status
  @State private var turn = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      if status == .working {
        Circle().stroke(status.color.opacity(0.25), lineWidth: 2)
        Circle().trim(from: 0, to: 0.7).stroke(status.color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
          .rotationEffect(.degrees(turn ? 360 : 0))
          .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { turn = true }
          }
      } else if status == .needsYou {
        Circle().stroke(status.color.opacity(0.45), lineWidth: 2)
        Circle().fill(status.color).padding(3)
      } else {
        Circle().fill(status.color).padding(3)
      }
    }
    .frame(width: 14, height: 14)
    .accessibilityHidden(true)
  }
}

/// Neutral glyphs for the two CLIs (no product logos).
extension Cli {
  var label: String { self == .claude ? "Claude Code" : "Codex" }
  var glyph: String { self == .claude ? "terminal" : "curlybraces" }
}

struct PrimaryButtonStyle: ButtonStyle {
  var tint: Color = Theme.primary
  var ink: Color = Theme.onPrimary
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .frame(maxWidth: .infinity, minHeight: 50)
      .foregroundStyle(ink)
      .background(tint.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

struct SecondaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.medium))
      .frame(maxWidth: .infinity, minHeight: 50)
      .foregroundStyle(Theme.text)
      .background(Theme.raised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

/// A rounded card on the page background.
struct Card<Content: View>: View {
  var stroke: Color? = nil
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 12) { content }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(stroke ?? Theme.border, lineWidth: stroke == nil ? 0.5 : 1.2))
  }
}

/// "coool" in its weight, for the pairing screen and About.
struct Wordmark: View {
  var size: CGFloat = 34
  var body: some View {
    Text("coool").font(.system(size: size, weight: .heavy, design: .rounded)).foregroundStyle(Theme.text)
      .accessibilityLabel("coool")
  }
}

func ago(_ ms: Int64?, now: Date = Date()) -> String {
  guard let ms else { return "never" }
  let s = max(0, Int(now.timeIntervalSince1970) - Int(ms / 1000))
  if s < 45 { return "just now" }
  if s < 3600 { return "\(max(1, s / 60)) min ago" }
  if s < 86400 { return "\(s / 3600) h ago" }
  return Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
}
