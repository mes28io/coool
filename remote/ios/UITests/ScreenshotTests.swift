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

  func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

  func back(_ app: XCUIApplication) {
    app.navigationBars.buttons.element(boundBy: 0).tap()
    Thread.sleep(forTimeInterval: 0.5)
  }

  func testScreens() throws {
    guard let dir = env["COOOL_SHOTS"] else { throw XCTSkip("COOOL_SHOTS not set") }
    let look = env["COOOL_APPEARANCE"] ?? "any"
    func save(_ n: String) {
      Thread.sleep(forTimeInterval: 0.7)
      shot(dir, "\(look)-\(n)")
    }

    var app = launch("pairing")
    XCTAssertTrue(app.buttons["pair.scan"].waitForExistence(timeout: 10))
    save("01-pairing")
    app = launch("revoked")
    XCTAssertTrue(any(app, "pair.revoked").waitForExistence(timeout: 10))
    save("02-revoked")
    app = launch("code")
    XCTAssertTrue(app.staticTexts["pair.code"].waitForExistence(timeout: 10))
    save("03-code")

    app = launch("home")
    XCTAssertTrue(any(app, "home.pulse").waitForExistence(timeout: 10))
    save("04-home")
    app.swipeUp()
    save("05-home-projects")
    app.swipeUp()
    save("06-home-ledger")
    app.swipeDown()
    app.swipeDown()
    app.swipeDown()

    any(app, "need|1:a|chat:1|Bash").tap()
    XCTAssertTrue(app.buttons["need.allow"].waitForExistence(timeout: 5))
    save("07-need-command")
    back(app)
    any(app, "need|2:e|chat:2|Edit").tap()
    XCTAssertTrue(app.buttons["need.allow"].waitForExistence(timeout: 5))
    save("08-need-edit")
    back(app)
    any(app, "need|6:p|chat:6|ExitPlanMode").tap()
    XCTAssertTrue(app.buttons["need.keep"].waitForExistence(timeout: 5))
    save("09-plan")
    back(app)
    any(app, "need|5:b|chat:5|Question").tap()
    XCTAssertTrue(app.buttons["need.answer"].waitForExistence(timeout: 5))
    app.buttons["need.option|CloudKit"].tap()
    save("10-question")
    back(app)

    any(app, "session|chat:2|atlas-api").tap()
    XCTAssertTrue(app.textFields["chat.input"].waitForExistence(timeout: 5))
    save("11-chat-live")
    app.swipeDown()
    save("12-chat-top")
    let img = any(app, "chat.image|demo-sketch")
    if img.waitForExistence(timeout: 3) {
      img.tap()
      if app.buttons["lightbox.close"].waitForExistence(timeout: 3) {
        save("13-lightbox")
        app.buttons["lightbox.close"].tap()
      }
    }
    let dev = any(app, "chat.device|browser")
    if dev.waitForExistence(timeout: 3) {
      dev.tap()
      XCTAssertTrue(any(app, "device.frame").waitForExistence(timeout: 5))
      save("14-device")
      back(app)
    }
    back(app)

    app.buttons["toolbar.new"].tap()
    XCTAssertTrue(app.buttons["new.project|atlas-api"].waitForExistence(timeout: 5))
    app.buttons["new.project|atlas-api"].tap()
    save("15-new-chat")
    app.swipeUp()
    save("16-new-chat-more")
    app.buttons["Cancel"].tap()
    app.buttons["toolbar.settings"].tap()
    XCTAssertTrue(app.buttons["settings.unpair"].waitForExistence(timeout: 5))
    save("17-settings")

    app = launch("offline")
    XCTAssertTrue(any(app, "home.offline").waitForExistence(timeout: 10))
    save("18-offline")
    app = launch("empty")
    XCTAssertTrue(any(app, "home.pulse").waitForExistence(timeout: 10))
    save("19-empty")
  }
}
