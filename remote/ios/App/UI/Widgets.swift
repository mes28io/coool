// Code changes readable on a phone (a compact line diff with syntax colour in coool's palette), a plan rendered as
// Markdown, images of a chat (thumbnails that open full screen), and a device panel's picture (view only).

import RemoteProtocol
import SwiftUI

// ---------------------------------------------------------------- diff

struct DiffLine: Equatable {
  enum Op { case same, add, del, gap }
  let op: Op
  let text: String
}

/// A line diff (LCS) of `before` -> `after`, with unchanged runs folded to two lines of context.
func lineDiff(_ before: String, _ after: String, context: Int = 2) -> [DiffLine] {
  let a = before.isEmpty ? [] : before.components(separatedBy: "\n").prefix(400).map { $0 }
  let b = after.isEmpty ? [] : after.components(separatedBy: "\n").prefix(400).map { $0 }
  var t = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
  for i in stride(from: a.count - 1, through: 0, by: -1) {
    for j in stride(from: b.count - 1, through: 0, by: -1) {
      t[i][j] = a[i] == b[j] ? t[i + 1][j + 1] + 1 : max(t[i + 1][j], t[i][j + 1])
    }
  }
  var out: [DiffLine] = []
  var i = 0, j = 0
  while i < a.count || j < b.count {
    if i < a.count, j < b.count, a[i] == b[j] {
      out.append(.init(op: .same, text: a[i])); i += 1; j += 1
    } else if i < a.count, j == b.count || t[i + 1][j] >= t[i][j + 1] {
      out.append(.init(op: .del, text: a[i])); i += 1
    } else {
      out.append(.init(op: .add, text: b[j])); j += 1
    }
  }
  // Fold long unchanged runs.
  var folded: [DiffLine] = []
  var k = 0
  while k < out.count {
    if out[k].op != .same { folded.append(out[k]); k += 1; continue }
    var e = k
    while e < out.count, out[e].op == .same { e += 1 }
    let run = Array(out[k..<e])
    let head = k == 0 ? 0 : context, tail = e == out.count ? 0 : context
    if run.count > head + tail + 1 {
      folded += run.prefix(head)
      folded.append(.init(op: .gap, text: "\(run.count - head - tail) unchanged lines"))
      folded += run.suffix(tail)
    } else {
      folded += run
    }
    k = e
  }
  return folded
}

/// Syntax colour in coool's palette: keywords blue, strings green, numbers amber, comments faint.
enum Syntax {
  static let keywords: Set<String> = ["fn", "let", "mut", "pub", "struct", "enum", "impl", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "async", "await", "func", "var", "class", "import", "export", "const", "function", "def", "from", "self", "Self", "true", "false", "nil", "null", "None", "Some", "Ok", "Err", "type", "interface", "extends", "static", "private", "public", "guard", "in", "of", "new", "try", "catch", "throw", "throws", "where", "trait", "dyn", "crate", "super", "switch", "case", "default", "break", "continue", "package", "go", "val", "override", "protocol", "extension", "init", "lambda", "yield", "with", "as", "is", "not", "and", "or"]

  static func line(_ s: String, comment: String) -> AttributedString {
    var out = AttributedString()
    var i = s.startIndex
    func add(_ t: Substring, _ c: Color?) {
      var a = AttributedString(t)
      if let c { a.foregroundColor = c }
      out += a
    }
    while i < s.endIndex {
      let rest = s[i...]
      if rest.hasPrefix(comment) || (comment == "//" && rest.hasPrefix("/*")) {
        add(rest, Theme.faint); break
      }
      let ch = s[i]
      if ch == "\"" || ch == "'" || ch == "`" {
        var j = s.index(after: i)
        while j < s.endIndex, s[j] != ch { j = s[j] == "\\" && s.index(after: j) < s.endIndex ? s.index(j, offsetBy: 2) : s.index(after: j) }
        let end = j < s.endIndex ? s.index(after: j) : j
        add(s[i..<end], Theme.doneText); i = end; continue
      }
      if ch.isLetter || ch == "_" {
        var j = i
        while j < s.endIndex, s[j].isLetter || s[j].isNumber || s[j] == "_" { j = s.index(after: j) }
        let w = s[i..<j]
        add(w, keywords.contains(String(w)) ? Theme.working : nil); i = j; continue
      }
      if ch.isNumber {
        var j = i
        while j < s.endIndex, s[j].isNumber || s[j] == "." || s[j] == "_" || s[j] == "x" { j = s.index(after: j) }
        add(s[i..<j], Theme.needsText); i = j; continue
      }
      add(s[i...i], nil); i = s.index(after: i)
    }
    return out
  }

  static func comment(for path: String) -> String {
    let ext = (path as NSString).pathExtension.lowercased()
    return ["py", "sh", "rb", "yml", "yaml", "toml", "zsh", "bash", "pl", "r", "conf"].contains(ext) ? "#" : ext == "sql" || ext == "lua" ? "--" : "//"
  }

  static func coded(_ path: String) -> Bool {
    !["md", "txt", "markdown", "rst", ""].contains((path as NSString).pathExtension.lowercased())
  }
}

struct DiffView: View {
  let diff: Diff
  var maxLines: Int = 60
  @State private var all = false

  var body: some View {
    let lines = lineDiff(diff.before, diff.after)
    let added = lines.filter { $0.op == .add }.count, removed = lines.filter { $0.op == .del }.count
    let shown = all ? lines : Array(lines.prefix(maxLines))
    let comment = Syntax.comment(for: diff.path), coded = Syntax.coded(diff.path)
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: diff.before.isEmpty ? "doc.badge.plus" : "pencil").imageScale(.small).foregroundStyle(Theme.dim)
        Text(diff.path).font(.caption.monospaced()).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.head)
        Spacer(minLength: 4)
        if added > 0 { Text("+\(added)").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Theme.doneText) }
        if removed > 0 { Text("−\(removed)").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Theme.error) }
      }
      .padding(.horizontal, 10).padding(.vertical, 8)
      Divider().overlay(Theme.border)
      ScrollView(.horizontal, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(shown.enumerated()), id: \.offset) { _, l in
            HStack(spacing: 0) {
              Text(l.op == .add ? "+" : l.op == .del ? "−" : l.op == .gap ? "⋯" : " ")
                .foregroundStyle(l.op == .add ? Theme.doneText : l.op == .del ? Theme.error : Theme.faint)
                .frame(width: 16, alignment: .center)
              if l.op == .gap {
                Text(l.text).foregroundStyle(Theme.faint).italic()
              } else {
                Text(coded ? Syntax.line(l.text, comment: comment) : AttributedString(l.text)).foregroundStyle(Theme.text)
              }
            }
            .font(.caption.monospaced())
            .padding(.vertical, 1.5).padding(.trailing, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(l.op == .add ? Theme.done.opacity(0.13) : l.op == .del ? Theme.error.opacity(0.12) : .clear)
          }
        }
        .padding(.vertical, 6)
        .textSelection(.enabled)
      }
      if lines.count > maxLines || diff.cut == true {
        Button(all ? "Show less" : lines.count > maxLines ? "Show all \(lines.count) lines" : "Cut on the Mac: open it there to see all") {
          withAnimation(Theme.calm) { all.toggle() }
        }
        .font(.caption.weight(.medium)).foregroundStyle(Theme.dim)
        .padding(10)
        .disabled(lines.count <= maxLines)
      }
    }
    .background(Theme.raised.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Change to \(diff.path): \(added) lines added, \(removed) removed. \(diff.after.prefix(300))")
    .accessibilityIdentifier("diff|\(diff.path)")
  }
}

// ---------------------------------------------------------------- markdown

/// Block-level Markdown for plans and replies: headings, lists, quotes, code, paragraphs.
struct MarkdownView: View {
  let text: String

  enum Block: Hashable {
    case heading(Int, String), bullet(String, Int), numbered(String, String), quote(String), code(String), para(String), rule
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, b in block(b) }
    }
  }

  @ViewBuilder private func block(_ b: Block) -> some View {
    switch b {
    case .heading(let l, let t):
      Text(inline(t)).font(l == 1 ? .title3.weight(.semibold) : l == 2 ? .headline : .subheadline.weight(.semibold)).foregroundStyle(Theme.text).padding(.top, 4)
    case .bullet(let t, let depth):
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("•").foregroundStyle(Theme.faint)
        Text(inline(t)).foregroundStyle(Theme.text)
      }
      .padding(.leading, CGFloat(depth) * 14)
    case .numbered(let n, let t):
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(n).foregroundStyle(Theme.faint).monospacedDigit()
        Text(inline(t)).foregroundStyle(Theme.text)
      }
    case .quote(let t):
      HStack(spacing: 10) {
        Rectangle().fill(Theme.border).frame(width: 3)
        Text(inline(t)).foregroundStyle(Theme.dim)
      }
    case .code(let c):
      ScrollView(.horizontal, showsIndicators: false) {
        Text(c).font(.caption.monospaced()).foregroundStyle(Theme.text).padding(10).textSelection(.enabled)
      }
      .background(Theme.raised.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    case .para(let t):
      Text(inline(t)).foregroundStyle(Theme.text).textSelection(.enabled)
    case .rule:
      Divider().overlay(Theme.border)
    }
  }

  private func inline(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
  }

  static func blocks(_ text: String) -> [Block] {
    var out: [Block] = []
    var para: [String] = []
    var code: [String]?
    func flush() {
      if !para.isEmpty { out.append(.para(para.joined(separator: " "))); para = [] }
    }
    for raw in text.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("```") {
        if let c = code { out.append(.code(c.joined(separator: "\n"))); code = nil } else { flush(); code = [] }
        continue
      }
      if code != nil { code!.append(raw); continue }
      if line.isEmpty { flush(); continue }
      if line == "---" || line == "***" { flush(); out.append(.rule); continue }
      if let m = line.firstIndex(where: { $0 != "#" }), line.hasPrefix("#"), line[m] == " " {
        flush(); out.append(.heading(line.distance(from: line.startIndex, to: m), String(line[m...]).trimmingCharacters(in: .whitespaces))); continue
      }
      if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
        flush()
        let depth = (raw.prefix { $0 == " " }.count) / 2
        var t = String(line.dropFirst(2))
        if t.hasPrefix("[ ] ") { t = "☐ " + t.dropFirst(4) } else if t.hasPrefix("[x] ") { t = "☑ " + t.dropFirst(4) }
        out.append(.bullet(t, depth)); continue
      }
      if let dot = line.firstIndex(of: "."), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty, line[line.index(after: dot)...].hasPrefix(" ") {
        flush(); out.append(.numbered(String(line[...dot]), String(line[line.index(dot, offsetBy: 2)...]))); continue
      }
      if line.hasPrefix(">") { flush(); out.append(.quote(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))); continue }
      para.append(line)
    }
    if let c = code { out.append(.code(c.joined(separator: "\n"))) }
    flush()
    return out
  }
}

// ---------------------------------------------------------------- images

/// An image of a chat (an attachment, by its key): asked for once, shown as it arrives; a tap opens it full screen.
struct ChatImage: View {
  let session: String
  let ref: ImageRef
  var side: CGFloat = 120
  @Environment(RemoteStore.self) private var store
  @State private var open = false

  var body: some View {
    Button { if store.images[ref.key] != nil { open = true } } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.raised)
        if let img = store.images[ref.key] {
          Image(uiImage: img).resizable().scaledToFill()
        } else {
          ProgressView().tint(Theme.faint)
        }
      }
      .frame(width: side, height: side)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
    }
    .buttonStyle(PressStyle())
    .onAppear { store.wantImage(session, ref.key) }
    .fullScreenCover(isPresented: $open) {
      if let img = store.images[ref.key] { Lightbox(image: img, title: ref.name ?? "Image") }
    }
    .accessibilityLabel("Image \(ref.name ?? ""), opens full screen")
    .accessibilityIdentifier("chat.image|\(ref.key)")
  }
}

/// An image full screen: pinch to zoom, double tap to fit, swipe down or Done to close.
struct Lightbox: View {
  let image: UIImage
  let title: String
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var last: CGFloat = 1
  @State private var drag: CGSize = .zero

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Color.black.opacity(max(0.4, 1 - abs(drag.height) / 600)).ignoresSafeArea()
      Image(uiImage: image).resizable().scaledToFit()
        .scaleEffect(scale)
        .offset(y: scale == 1 ? drag.height : 0)
        .gesture(MagnifyGesture().onChanged { scale = max(1, min(5, last * $0.magnification)) }.onEnded { _ in last = scale })
        .simultaneousGesture(DragGesture().onChanged { if scale == 1 { drag = $0.translation } }.onEnded { v in
          if abs(v.translation.height) > 120 { dismiss() } else { withAnimation(Theme.spring) { drag = .zero } }
        })
        .onTapGesture(count: 2) { withAnimation(Theme.spring) { scale = scale > 1 ? 1 : 2.5; last = scale } }
        .accessibilityLabel(title)
      Button { dismiss() } label: {
        Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(.white)
          .frame(width: 40, height: 40).background(.ultraThinMaterial, in: Circle())
      }
      .padding(16)
      .accessibilityLabel("Close")
      .accessibilityIdentifier("lightbox.close")
    }
    .statusBarHidden()
  }
}

// ---------------------------------------------------------------- device panels

extension String {
  var deviceLabel: String {
    switch self {
    case "browser": "Browser"
    case "simulator": "iPhone simulator"
    case "mac": "Sandbox Mac"
    default: self
    }
  }
  var deviceIcon: String {
    switch self {
    case "browser": "safari"
    case "simulator": "iphone"
    default: "desktopcomputer"
    }
  }
}

/// What the agent sees on a device panel, as a picture every few seconds while this is open. View only: nothing
/// here can touch the device.
struct DeviceView: View {
  let sessionId: String
  let device: String
  @Environment(RemoteStore.self) private var store

  var body: some View {
    let f = store.frame(sessionId, device)
    VStack(spacing: 14) {
      ZStack {
        RoundedRectangle(cornerRadius: device == "simulator" ? 28 : 14, style: .continuous).fill(Theme.raised)
        if let f {
          Image(uiImage: f.image).resizable().scaledToFit()
            .clipShape(RoundedRectangle(cornerRadius: device == "simulator" ? 24 : 10, style: .continuous))
            .padding(device == "simulator" ? 6 : 0)
            .transition(.opacity)
            .id(f.seq)
        } else if let e = store.frameError(sessionId, device) {
          EmptyState(icon: device.deviceIcon, title: "No picture", hint: e)
        } else {
          VStack(spacing: 10) {
            ProgressView()
            Text("Waiting for the first picture").font(.footnote).foregroundStyle(Theme.faint)
          }
        }
      }
      .frame(maxWidth: .infinity)
      .aspectRatio(f.map { $0.image.size.width / max(1, $0.image.size.height) } ?? (device == "simulator" ? 0.5 : 1.4), contentMode: .fit)
      .animation(Theme.calm, value: f?.seq)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(f == nil ? "No picture yet" : "\(device.deviceLabel), picture \(f!.seq)")
      .accessibilityValue("\(f?.seq ?? 0)")
      .accessibilityIdentifier("device.frame")
      HStack(spacing: 8) {
        if f != nil { Pulse(color: Theme.working, size: 6) }
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
          Text(f.map { "Updated \(max(0, Int(ctx.date.timeIntervalSince($0.at))))s ago" } ?? "Live while this is open").font(.footnote).foregroundStyle(Theme.dim)
        }
        Spacer()
        Chip(text: "View only", icon: "eye")
      }
      Text("A small picture every few seconds while you look, so it stays cheap. To act on the device, use coool on your Mac.")
        .font(.footnote).foregroundStyle(Theme.faint)
      Spacer(minLength: 0)
    }
    .padding(16)
    .background(Theme.bg)
    .navigationTitle(device.deviceLabel)
    .navigationBarTitleDisplayMode(.inline)
    .task { await store.watchDevice(sessionId, device) }
  }
}
