// Every screen with invented data (`--demo`, debug builds), for the screenshots in the docs and for review.
// COOOL_SHOTS (TEST_RUNNER_COOOL_SHOTS) is where the PNGs go; COOOL_APPEARANCE names them (dark / light: the
// Simulator's appearance is set from outside with `simctl ui <device> appearance`).

import XCTest

final class ScreenshotTests: XCTestCase {
  func launch(_ screen: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--reset", "--demo", screen]
    app.launch()
    return app
  }

  func testScreens() throws {
    guard let dir = env["COOOL_SHOTS"] else { throw XCTSkip("COOOL_SHOTS not set") }
    let look = env["COOOL_APPEARANCE"] ?? "any"
    func save(_ n: String) { shot(dir, "\(look)-\(n)") }

    var app = launch("pairing")
    XCTAssertTrue(app.buttons["pair.scan"].waitForExistence(timeout: 10))
    save("01-pairing")
    app = launch("revoked")
    XCTAssertTrue(app.descendants(matching: .any)["pair.revoked"].waitForExistence(timeout: 10))
    save("02-revoked")
    app = launch("code")
    XCTAssertTrue(app.staticTexts["pair.code"].waitForExistence(timeout: 10))
    save("03-code")

    app = launch("sessions")
    XCTAssertTrue(app.descendants(matching: .any)["mac.status"].waitForExistence(timeout: 10))
    save("04-sessions")
    app.descendants(matching: .any)["need|1:a|chat:1|Bash"].tap()
    XCTAssertTrue(app.buttons["need.allow"].waitForExistence(timeout: 5))
    save("05-need")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.descendants(matching: .any)["need|5:b|chat:5|Question"].tap()
    XCTAssertTrue(app.buttons["need.answer"].waitForExistence(timeout: 5))
    app.buttons["need.option|CloudKit"].tap()
    _ = app.buttons["need.option|CloudKit"].waitForExistence(timeout: 1)
    Thread.sleep(forTimeInterval: 0.6)
    save("06-question")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.swipeUp()
    app.descendants(matching: .any)["session|chat:2|atlas-api"].tap()
    XCTAssertTrue(app.textFields["chat.input"].waitForExistence(timeout: 5))
    save("07-chat")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.swipeDown()
    app.buttons["toolbar.new"].tap()
    XCTAssertTrue(app.buttons["new.project|atlas-api"].waitForExistence(timeout: 5))
    app.buttons["new.project|atlas-api"].tap()
    save("08-new-chat")
    app.buttons["Cancel"].tap()
    app.buttons["toolbar.settings"].tap()
    XCTAssertTrue(app.buttons["settings.unpair"].waitForExistence(timeout: 5))
    save("09-settings")
  }
}
