// Minor 2 on the phone's side: what it can say (notes, a model switch with no mode, a recording to transcribe),
// files and recordings typed by their bytes as the Mac checks them, the chat's composer state, and mixed versions.

import Foundation
@testable import RemoteProtocol
import XCTest

final class MinorTwoTests: XCTestCase {
  func testHelloSaysMinorTwo() {
    XCTAssertEqual(Remote.minor, 2)
    XCTAssertEqual(Command.hello(name: "x").body["minor"], .number(2))
  }

  func testNoteModelAndTranscribeBodies() {
    XCTAssertEqual(Command.note(session: "chat:1", note: "n-1", action: .now).body, ["session": "chat:1", "note": "n-1", "do": "now"])
    XCTAssertEqual(Command.note(session: "chat:1", note: "n-1", action: .cancel).type, "note")
    // A model switch carries a model and nothing else: no mode can ride along.
    let m = Command.setModel(session: "chat:1", model: "haiku")
    XCTAssertEqual(m.type, "set_model")
    XCTAssertEqual(m.body, ["session": "chat:1", "model": "haiku"])
    XCTAssertNil(m.body["mode"])
    XCTAssertEqual(Command.transcribe(upload: "ab", session: nil).body, ["upload": "ab"])
    XCTAssertEqual(Command.transcribe(upload: "ab", session: "chat:1").body, ["upload": "ab", "session": "chat:1"])
  }

  func testFilesAreTypedByTheirBytes() {
    XCTAssertEqual(fileType(Data("fn main() {}\n".utf8)), "text/plain")
    XCTAssertEqual(fileType(Data("%PDF-1.7\n\u{0}\u{1}".utf8)), "application/pdf")
    XCTAssertNil(fileType(Data([0x7F, 0x45, 0x4C, 0x46, 2, 1])), "an executable")
    XCTAssertNil(fileType(Data([0xFF, 0xFE, 0x41])), "not UTF-8")
    XCTAssertNil(fileType(Data("a\u{0}b".utf8)), "a NUL byte")
    XCTAssertNil(fileType(Data()))
  }

  func testRecordingsAreTypedByTheirBytes() {
    var m4a = Data([0, 0, 0, 0x1C]) + Data("ftypM4A ".utf8)
    m4a.append(Data(repeating: 1, count: 20))
    XCTAssertEqual(audioType(m4a), "audio/mp4")
    XCTAssertEqual(audioType(Data("RIFF\u{0}\u{0}\u{0}\u{0}WAVEfmt ".utf8)), "audio/wav")
    XCTAssertNil(audioType(Data("#!/bin/sh\nrm -rf ~\n".utf8)))
  }

  func testUploadPartsSayTheirKindAndOnlyAKnownEnding() {
    let d = Data("hello".utf8)
    let img = uploadParts(id: "0f0e0d0c0b0a09080706050403020100", d)
    XCTAssertNil(img[0]["kind"], "an image's parts are as in minor 1 (an older Mac takes them)")
    let f = uploadParts(id: "0f0e0d0c0b0a09080706050403020100", d, kind: .file, ext: "RS")
    XCTAssertEqual(f[0]["kind"], "file")
    XCTAssertEqual(f[0]["ext"], "rs")
    // A path or an unknown ending is never sent: the Mac names the file.
    for bad in ["../../etc/passwd", "sh\nrm", "exe", ""] {
      XCTAssertNil(uploadParts(id: "0f0e0d0c0b0a09080706050403020100", d, kind: .file, ext: bad)[0]["ext"], bad)
    }
    XCTAssertEqual(uploadParts(id: "0f0e0d0c0b0a09080706050403020100", d, kind: .audio)[0]["kind"], "audio")
  }

  func testAChatsMetaAndNotesAreRead() throws {
    let json = """
    {"v":1,"id":"x","t":"chat","at":1,"b":{"session":"chat:1","items":[],"cursor":4,
     "live":{"state":"working","notes":[{"id":"n1","text":"also docs","state":"queued","atts":1}]},
     "meta":{"cli":"claude","model":"haiku","models":[{"id":"haiku","label":"Haiku"}],"mode":"default","mode_label":"Ask",
       "context":1200,"window":200000,"commands":[{"name":"review","description":"Review","kind":"command"}],"future_field":true}}}
    """
    guard case .chat(let u) = Inbound.from(try Envelope.parse(Data(json.utf8))) else { return XCTFail("not read") }
    XCTAssertEqual(u.live?.notes, [LiveNote(id: "n1", text: "also docs", state: "queued", atts: 1)])
    XCTAssertEqual(u.meta?.modeLabel, "Ask")
    XCTAssertEqual(u.meta?.commands?.first?.name, "review")
    var log = LiveLog()
    log.apply(u)
    XCTAssertEqual(log.meta?.model, "haiku")
    // A later message without meta keeps it (the Mac sends it only when it changed).
    log.apply(ChatUpdate(session: "chat:1", items: [], live: ChatLive(state: "idle")))
    XCTAssertEqual(log.meta?.model, "haiku")
  }

  func testMixedVersions() throws {
    // An older Mac's snapshot has no minor (0); a newer one's says it.
    let old = #"{"v":1,"id":"a","t":"snapshot","at":1,"b":{"sessions":[],"needs":[]}}"#
    let new = #"{"v":1,"id":"a","t":"snapshot","at":1,"b":{"sessions":[],"needs":[],"minor":2}}"#
    XCTAssertEqual(Inbound.from(try Envelope.parse(Data(old.utf8))), .snapshot(sessions: [], needs: [], minor: 0))
    XCTAssertEqual(Inbound.from(try Envelope.parse(Data(new.utf8))), .snapshot(sessions: [], needs: [], minor: 2))
    // A result with minor 2's fields, and one without, both read.
    let r = #"{"v":1,"id":"b","t":"result","at":1,"b":{"of":"x","t":"transcribe","ok":true,"text":"add a retry","heard":"words"}}"#
    guard case .result(let res) = Inbound.from(try Envelope.parse(Data(r.utf8))) else { return XCTFail() }
    XCTAssertEqual(res.text, "add a retry")
    // Types this version doesn't know are ignored.
    XCTAssertEqual(Inbound.from(try Envelope.parse(Data(#"{"v":1,"id":"c","t":"hologram","at":1,"b":{}}"#.utf8))), .unknown("hologram"))
  }
}
