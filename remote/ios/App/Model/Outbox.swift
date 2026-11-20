// What the phone has sent and the Mac hasn't shown yet: each message or note appears at once as an optimistic
// bubble (sending, then sent once the Mac answers), settles in place when the Mac's own copy arrives in the chat's
// live view, and shows a quiet retry if it fails. Also: things picked to send (pictures, files) and per-chat drafts.

import Foundation
import RemoteProtocol
import UIKit

/// A picture or file picked for the next message.
struct Attachment: Identifiable, Equatable {
  enum Kind: Equatable { case image, file }
  let id: String
  var kind: Kind
  /// Shown on its chip ("IMG_2041.jpg", "notes.md"); never sent: the Mac names what it stores.
  var name: String
  /// For a picture, the image (scaled and encoded when sent); for a file, its bytes as picked.
  var image: UIImage?
  var data: Data?

  init(image: UIImage, name: String = "Picture") {
    id = randomId()
    kind = .image
    self.name = name
    self.image = image
  }

  init(file data: Data, name: String) {
    id = randomId()
    kind = .file
    self.name = name
    self.data = data
  }

  var ext: String { (name as NSString).pathExtension.lowercased() }
  var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(data?.count ?? 0), countStyle: .file) }

  static func == (a: Attachment, b: Attachment) -> Bool { a.id == b.id }

  /// Why this file can't go (the same rules the Mac applies): nil if it can.
  static func refusal(file data: Data) -> String? {
    if data.count > Remote.maxUpload { return "Files from the phone can be up to \(Remote.maxUpload / 1_000_000) MB." }
    if fileType(data) == nil { return "Only PDFs and text files (code, notes, data) can be sent." }
    return nil
  }
}

/// A message or note on its way.
struct Outgoing: Identifiable, Equatable {
  enum State: Equatable {
    case sending
    /// The Mac took it; its copy hasn't shown in the chat yet.
    case sent
    case failed(String)
  }
  let id: String
  let session: String
  var text: String
  var attachments: [Attachment]
  var how: Delivery
  var state: State = .sending
  let at = Date()
  /// The chat's user items when it was sent: the Mac's copy is a new one with the same text.
  var known: Set<String>
  /// The note id the Mac gave it (a note).
  var note: String?

  var isNote: Bool { how != .send }
}

enum Drafts {
  static func get(_ session: String) -> String { UserDefaults.standard.string(forKey: "draft.\(session)") ?? "" }
  static func set(_ session: String, _ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { UserDefaults.standard.removeObject(forKey: "draft.\(session)") } else { UserDefaults.standard.set(text, forKey: "draft.\(session)") }
  }
}

/// Matching the Mac's copy of what the phone sent: by text, oldest first, only items that weren't there before.
enum Settle {
  static func norm(_ s: String?) -> String { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

  /// For each outgoing message, the user item that is its copy (if it arrived): outgoing id -> item key.
  static func match(_ out: [Outgoing], items: [LiveItem], taken: Set<String>) -> [String: String] {
    var used = taken
    var r: [String: String] = [:]
    for o in out {
      if case .failed = o.state { continue }
      let want = norm(o.text)
      guard let it = items.first(where: { $0.role == "user" && !used.contains($0.k) && !o.known.contains($0.k) && norm($0.text) == want && (o.isNote || $0.steer != true) }) else { continue }
      used.insert(it.k)
      r[o.id] = it.k
    }
    return r
  }

  /// Notes the Mac now lists (queued or settled) for outgoing notes: outgoing id -> note id.
  static func notes(_ out: [Outgoing], notes: [LiveNote], taken: Set<String>) -> [String: String] {
    var used = taken
    var r: [String: String] = [:]
    for o in out where o.isNote {
      if case .failed = o.state { continue }
      let want = norm(o.text)
      if let n = (o.note.flatMap { id in notes.first { $0.id == id } }) ?? notes.first(where: { !used.contains($0.id) && norm($0.text) == want }) {
        used.insert(n.id)
        r[o.id] = n.id
      }
    }
    return r
  }
}
