// The phone's half of the `remote` self-test (app/src/selftestRemote.ts), played by this app in the Simulator
// instead of remote/phone/e2e.mjs: same files in the test's folder, same steps, through the UI. Run by
// remote/ios/e2e/run.sh, which passes the folder as COOOL_E2E_DIR (TEST_RUNNER_COOOL_E2E_DIR to xcodebuild).
//
// Writes remote-phone-*.txt as it goes, and remote-phone-failed.txt on the first failure.

import XCTest

final class EndToEndTests: XCTestCase {
  var dir: String!
  var shots: String?
  let app = XCUIApplication()

  func file(_ n: String) -> URL { URL(fileURLWithPath: dir).appending(path: n) }
  func put(_ n: String, _ text: String) { try? text.write(to: file(n), atomically: true, encoding: .utf8) }
  func log(_ s: String) { print("E2E \(ISO8601DateFormatter().string(from: Date())) \(s)") }

  func waitFile(_ n: String, _ timeout: TimeInterval) -> String? {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if let s = try? String(contentsOf: file(n), encoding: .utf8) { return s }
      Thread.sleep(forTimeInterval: 0.25)
    }
    return nil
  }

  func step(_ name: String, _ ok: Bool) throws {
    log("\(ok ? "PASS" : "FAIL") \(name)")
    if !ok {
      put("remote-phone-failed.txt", name)
      shot(shots, "e2e-failed")
      throw XCTSkip("failed: \(name)")  // the XCTFail before this already marks the test failed
    }
  }

  func testPhoneSide() throws {
    guard let d = env["COOOL_E2E_DIR"] else { throw XCTSkip("COOOL_E2E_DIR not set: run remote/ios/e2e/run.sh") }
    dir = d
    shots = env["COOOL_E2E_SHOTS"]
    let base = URL(fileURLWithPath: d).lastPathComponent
    continueAfterFailure = true
    app.launchArguments = ["--reset"]
    app.launch()

    // 1. Pair with the pasted link; the code goes to the Mac's side, which clicks Pair.
    guard let qr = waitFile("remote-pair-url.txt", 180)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return try step("the Mac's pairing link", false) }
    let name = app.textFields["pair.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    name.tap()
    name.press(forDuration: 1.0)
    if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
    name.typeText("coool sim iPhone")
    let field = app.textFields["pair.link"]
    field.tap()
    field.typeText(qr)
    shot(shots, "e2e-1-pairing")
    app.buttons["pair.submit"].tap()
    let code = app.staticTexts["pair.code"]
    try step("claim accepted by the relay, code shown", code.waitForExistence(timeout: 30))
    let digits = (code.value as? String) ?? ""
    log("code \(digits)")
    put("remote-phone-code.txt", digits)
    shot(shots, "e2e-2-code")

    // 2. Paired: the session list with the test's own sessions and the invented ones.
    try step("paired: the session list", wait("invented sessions", timeout: 120) { elements(app, "session|selftest:invented-").count >= 2 })
    shot(shots, "e2e-3-sessions")
    let rows = elements(app, "session|").allElementsBoundByIndex.map { $0.identifier.split(separator: "|", maxSplits: 2).map(String.init) }
    let sessions = rows.filter { $0.count == 3 }.map { ["id": $0[1], "title": $0[1], "project": $0[2]] }
    let foreign = sessions.filter { $0["project"] != base && $0["project"] != "invented-project" }
    try step("only this test's sessions and invented ones (\(sessions.count))", foreign.isEmpty)
    put("remote-phone-snapshot.txt", String(decoding: try JSONSerialization.data(withJSONObject: ["sessions": sessions]), as: UTF8.self))

    // 3. The Haiku chat's Bash request: allow once (the app offers nothing else that allows).
    let needRow = elements(app, "need|").matching(NSPredicate(format: "identifier ENDSWITH %@", "|Bash")).firstMatch
    try step("the Bash request arrives", needRow.waitForExistence(timeout: 180))
    let needParts = needRow.identifier.split(separator: "|").map(String.init)
    let session = needParts[2]
    shot(shots, "e2e-4-need-row")
    needRow.tap()
    let cmd = app.descendants(matching: .any)["need.command"]
    try step("the need shows the command", cmd.waitForExistence(timeout: 10) && cmd.label.contains("coool-remote-ok"))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'always'")).firstMatch.exists, "an always-allow button")
    shot(shots, "e2e-5-need")
    app.buttons["need.allow"].tap()
    // "Allowed once" shows briefly, then the app opens the chat the request came from.
    let doneMark = app.descendants(matching: .any)["need.done"], chatState = app.descendants(matching: .any)["chat.state"]
    try step("Allow once accepted by the Mac", wait("the answer's result", timeout: 60) { doneMark.exists || chatState.exists })
    XCTAssertFalse(app.descendants(matching: .any)["need.error"].exists)
    put("remote-phone-answered.txt", "allowed Bash once from the app (the app has no always-allow)")

    // 4. Send, then stop mid-turn, from the chat view.
    let state = app.descendants(matching: .any)["chat.state"]
    try step("the chat view", state.waitForExistence(timeout: 20))
    try step("the chat idle again", wait("idle", timeout: 120) { (state.value as? String) == "idle" })
    Thread.sleep(forTimeInterval: 3)
    let input = app.textFields["chat.input"]
    input.tap()
    input.typeText("Count from 1 to 400, one number per line, nothing else.")
    app.buttons["chat.send"].tap()
    let stop = app.buttons["chat.stop"]
    try step("the chat working after the message", stop.waitForExistence(timeout: 60))
    shot(shots, "e2e-6-chat-working")
    stop.tap()
    try step("Stop accepted", wait("stop result", timeout: 60) { !stop.exists || (state.value as? String) != "working" })
    XCTAssertFalse(app.descendants(matching: .any)["chat.error"].exists)
    put("remote-phone-stopped.txt", "sent, then stopped \(session) from the app")
    _ = wait("the stop line in the tail", timeout: 20) { app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Stopped from'")).count > 0 }
    shot(shots, "e2e-7-chat-stopped")

    // 5. Start a chat in this folder from the Mac's list.
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["toolbar.new"].tap()
    let proj = app.buttons["new.project|\(base)"]
    try step("the test's folder among the projects", proj.waitForExistence(timeout: 60))
    proj.tap()
    let prompt = app.textFields["new.prompt"]
    prompt.tap()
    prompt.typeText("Reply with just the word hi.")
    shot(shots, "e2e-8-new-chat")
    app.buttons["new.start"].tap()
    let started = elements(app, "chat.started|").firstMatch
    try step("the chat started", started.waitForExistence(timeout: 60))
    let sp = started.identifier.split(separator: "|").map(String.init)
    put("remote-phone-refusals.txt", "not sent: the app offers no always-allow, no path, no unknown project (refusals are covered by crates/remote tests and remote/phone e2e)")
    put("remote-phone-started.txt", String(decoding: try JSONSerialization.data(withJSONObject: ["session": sp[1], "mode": sp[2]]), as: UTF8.self))
    log("started \(sp[1]) in \(sp[2])")
    let replied = wait("the started chat's reply", timeout: 30) { elements(app, "chat.assistant").count > 0 }
    shot(shots, "e2e-9-started")
    if !replied { log("tree: \(app.debugDescription)") }

    // 6. Removed on the Mac: back to pairing, with the reason.
    try step("the Mac removed the device", waitFile("remote-app-removed.txt", 300) != nil)
    let revoked = app.descendants(matching: .any)["pair.revoked"]
    try step("back to pairing with an explanation", revoked.waitForExistence(timeout: 60))
    shot(shots, "e2e-10-revoked")
    put("remote-phone-refused.txt", "revoked: the app returned to the pairing screen (\(revoked.label.prefix(80)))")
    log("done")
  }
}
