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
    // `--e2e-image`: the attach menu offers an invented picture, and New chat a button that asks for Bypass (refused).
    app.launchArguments = ["--reset", "--e2e-image"]
    app.launch()
    put("remote-phone-minor.txt", "1")

    // 1. Pair with the pasted link; the code goes to the Mac's side, which clicks Pair.
    guard let qr = waitFile("remote-pair-url.txt", 180)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return try step("the Mac's pairing link", false) }
    // The device keeps its default name ("iPhone"); on an iPhone SE-sized screen the fields sit low, so each is
    // brought into view and typed into only once the keyboard is up.
    let field = app.textFields["pair.link"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    if !field.isHittable { app.swipeUp() }
    field.tap()
    if !app.keyboards.firstMatch.waitForExistence(timeout: 5) { field.tap() }
    _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
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

    // 3. The Haiku chat's Write request, shown as a diff: allow once. The app then shows the chat live.
    let writeRow = elements(app, "need|").matching(NSPredicate(format: "identifier ENDSWITH %@", "|Write")).firstMatch
    try step("the Write request arrives", writeRow.waitForExistence(timeout: 180))
    let session = writeRow.identifier.split(separator: "|").map(String.init)[2]
    shot(shots, "e2e-4-need-row")
    writeRow.tap()
    let diff = elements(app, "diff|").firstMatch
    try step("the request shows its change as a diff", diff.waitForExistence(timeout: 10) && diff.label.contains("hello from coool remote"))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'always'")).firstMatch.exists, "an always-allow button")
    shot(shots, "e2e-5-need-diff")
    app.buttons["need.allow"].tap()
    let doneMark = app.descendants(matching: .any)["need.done"], chatState = app.descendants(matching: .any)["chat.state"]
    try step("Allow once (Write) accepted by the Mac", wait("the answer's result", timeout: 60) { doneMark.exists || chatState.exists })
    XCTAssertFalse(app.descendants(matching: .any)["need.error"].exists)

    // The live view: steps appear while the turn runs (no pull, no reload).
    let state = app.descendants(matching: .any)["chat.state"]
    try step("the chat view", state.waitForExistence(timeout: 20))
    // Steps and replies on screen: what arrives after the Bash allow (its result, the reply) arrives live.
    let items = { self.elements(self.app, "chat.item|").count + self.elements(self.app, "chat.assistant").count }
    _ = wait("the live view's first items", timeout: 30) { items() > 0 }
    let before = items()
    let bashCard = elements(app, "chat.need|").firstMatch
    try step("the Bash request arrives in the live chat", bashCard.waitForExistence(timeout: 120))
    shot(shots, "e2e-6-live")
    bashCard.tap()
    let cmd = app.descendants(matching: .any)["need.command"]
    try step("the need shows the command", cmd.waitForExistence(timeout: 10) && cmd.label.contains("coool-remote-ok"))
    shot(shots, "e2e-7-need-bash")
    app.buttons["need.allow"].tap()
    try step("Allow once (Bash) accepted by the Mac", wait("the answer's result", timeout: 60) { doneMark.exists || chatState.exists })
    put("remote-phone-answered.txt", "allowed Write (seen as a diff) and Bash once from the app (the app has no always-allow)")
    try step("the chat view again", state.waitForExistence(timeout: 20))
    try step("the chat idle again", wait("idle", timeout: 120) { (state.value as? String) == "idle" })
    _ = wait("the reply, live", timeout: 60) { self.elements(self.app, "chat.assistant").count > 0 }
    let after = items()
    let diffInChat = elements(app, "diff|notes.txt").count > 0 || elements(app, "diff|").count > 0
    shot(shots, "e2e-8-live-done")
    try step("the live view grew during the turn (\(before) -> \(after) steps) and shows the edit", after > before && after >= 2 && diffInChat)
    put("remote-phone-live.txt", "live view: \(before) -> \(after) steps while watching, the Write shown as a diff")

    // 3b. The chat's Browser panel, as pictures (the Mac opens a local page; no model).
    if waitFile("remote-app-browser.txt", 90) != nil {
      let chip = app.descendants(matching: .any)["chat.device|browser"]
      try step("the chat offers its Browser panel", chip.waitForExistence(timeout: 30))
      chip.tap()
      let frame = app.descendants(matching: .any)["device.frame"]
      try step("the device view", frame.waitForExistence(timeout: 10))
      let got = wait("two pictures", timeout: 60) { Int((frame.value as? String) ?? "0") ?? 0 >= 2 }
      shot(shots, "e2e-9-device")
      let seq = (frame.value as? String) ?? "0"
      try step("pictures of the Browser panel arrive (\(seq))", got)
      put("remote-phone-frames.txt", "\(seq) pictures of the Browser panel, view only")
      app.navigationBars.buttons.element(boundBy: 0).tap()
      try step("back in the chat", state.waitForExistence(timeout: 10))
    }
    Thread.sleep(forTimeInterval: 3)
    let input = app.textFields["chat.input"]
    input.tap()
    typeInto(input, "Count from 1 to 400, one number per line, nothing else.")
    app.buttons["chat.send"].tap()
    let stop = app.buttons["chat.stop"]
    try step("the chat working after the message", stop.waitForExistence(timeout: 60))
    _ = wait("the step or the text streaming in", timeout: 15) { app.descendants(matching: .any)["chat.stream"].exists || app.descendants(matching: .any)["chat.live.step"].exists }
    shot(shots, "e2e-13-chat-working")
    stop.tap()
    try step("Stop accepted", wait("stop result", timeout: 60) { !stop.exists || (state.value as? String) != "working" })
    XCTAssertFalse(app.descendants(matching: .any)["chat.error"].exists)
    put("remote-phone-stopped.txt", "sent, then stopped \(session) from the app")
    _ = wait("the stop line in the tail", timeout: 20) { app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Stopped from'")).count > 0 }
    shot(shots, "e2e-14-chat-stopped")

    // 5. Start a chat in this folder: Bypass is refused; then Haiku, acceptEdits, with a picture.
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["toolbar.new"].tap()
    let proj = app.buttons["new.project|\(base)"]
    try step("the test's folder among the projects", proj.waitForExistence(timeout: 60))
    proj.tap()
    let prompt = app.textFields["new.prompt"]
    prompt.tap()
    typeInto(prompt, "What is in the attached picture? Answer in at most eight words.")
    app.swipeDown()
    let forbidden = app.buttons["new.forbidden"]
    if !forbidden.isHittable { app.swipeUp() }
    forbidden.tap()
    let err = app.descendants(matching: .any)["new.error"]
    try step("a start in Bypass is refused by the Mac", err.waitForExistence(timeout: 60) && err.label.contains("can't use that mode"))
    put("remote-phone-refusals.txt", "Bypass refused by the Mac: \(err.label.prefix(90))")
    shot(shots, "e2e-10-refused")
    app.swipeDown()
    let model = app.buttons["new.model"]
    try step("the Mac's models offered", model.waitForExistence(timeout: 20))
    model.tap()
    let haiku = app.buttons["new.model|haiku"]
    try step("Haiku among them", haiku.waitForExistence(timeout: 5))
    haiku.tap()
    let accept = app.buttons["new.mode|acceptEdits"]
    try step("the asking modes offered", accept.waitForExistence(timeout: 5))
    accept.tap()
    XCTAssertFalse(app.buttons["new.mode|bypassPermissions"].exists, "Bypass offered")
    let attach = app.buttons["chat.attach"].firstMatch
    if !attach.isHittable { app.swipeUp() }
    attach.tap()
    let test = app.buttons["attach.test"]
    try step("the attach menu", test.waitForExistence(timeout: 5))
    test.tap()
    try step("the picture is ready to send", elements(app, "attach.pic|").firstMatch.waitForExistence(timeout: 5))
    shot(shots, "e2e-11-new-chat")
    app.buttons["new.start"].tap()
    let started = elements(app, "chat.started|").firstMatch
    try step("the chat started", started.waitForExistence(timeout: 120))
    let sp = started.identifier.split(separator: "|").map(String.init)
    log("started \(sp[1]) in \(sp[2])")
    let reply = elements(app, "chat.assistant").firstMatch
    let replied = wait("the started chat's reply", timeout: 120) { reply.exists }
    let said = replied ? reply.label : ""
    put("remote-phone-started.txt", String(decoding: try JSONSerialization.data(withJSONObject: ["session": sp[1], "mode": sp[2], "model": "haiku", "reply": said]), as: UTF8.self))
    shot(shots, "e2e-12-started")
    if !replied { log("tree: \(app.debugDescription)") }

    // 6. Removed on the Mac: back to pairing, with the reason.
    try step("the Mac removed the device", waitFile("remote-app-removed.txt", 300) != nil)
    let revoked = app.descendants(matching: .any)["pair.revoked"]
    try step("back to pairing with an explanation", revoked.waitForExistence(timeout: 60))
    shot(shots, "e2e-15-revoked")
    put("remote-phone-refused.txt", "revoked: the app returned to the pairing screen (\(revoked.label.prefix(80)))")
    log("done")
  }
}

extension EndToEndTests {
  /// Types into a field once the keyboard is up (on a small screen the first tap can land before focus does).
  func typeInto(_ el: XCUIElement, _ text: String) {
    if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { el.tap() }
    _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
    el.typeText(text)
  }
}
