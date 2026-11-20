// The feel of sending, with invented data (`--demo`): open an idle chat, send a message, watch the reply stream in
// the way the Mac packs it (about once a second). Run under a Simulator video recording to look at it frame by frame
// (see remote/ios/e2e/feel.sh). Also checks the optimistic bubble: it shows at once and settles into the Mac's copy.

import XCTest

final class FeelTests: XCTestCase {
  func testSendAndStream() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--reset", "--demo", "home"]
    app.launch()
    let row = app.descendants(matching: .any).matching(identifier: "session|chat:4|atlas-api").firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    let input = app.textFields["chat.input"]
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    Thread.sleep(forTimeInterval: 1.5)
    input.tap()
    _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
    input.typeText("Add a retry with backoff to the upload client")
    Thread.sleep(forTimeInterval: 0.8)
    print("FEEL send \(Date().timeIntervalSince1970)")
    app.buttons["chat.send"].tap()
    // The bubble is there at once (sending or sent), before the Mac's copy.
    let out = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chat.out|'")).firstMatch
    XCTAssertTrue(out.waitForExistence(timeout: 0.5), "no optimistic bubble")
    XCTAssertEqual((input.value as? String)?.contains("retry") ?? false, false, "the field still holds the text")
    // It settles: the outgoing row becomes the Mac's copy (same row, no status line).
    XCTAssertTrue(wait("settled", timeout: 5) { !out.exists })
    let stream = app.descendants(matching: .any)["chat.stream"]
    XCTAssertTrue(stream.waitForExistence(timeout: 5))
    print("FEEL stream \(Date().timeIntervalSince1970)")
    XCTAssertTrue(wait("the reply", timeout: 20) { app.descendants(matching: .any).matching(identifier: "chat.assistant").count >= 2 })
    print("FEEL done \(Date().timeIntervalSince1970)")
    Thread.sleep(forTimeInterval: 1)
  }
}
