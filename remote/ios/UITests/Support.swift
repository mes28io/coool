import XCTest

extension XCTestCase {
  var env: [String: String] { ProcessInfo.processInfo.environment }

  /// Elements whose accessibility identifier starts with `prefix`.
  func elements(_ app: XCUIApplication, _ prefix: String) -> XCUIElementQuery {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
  }

  @discardableResult
  func wait(_ what: String, timeout: TimeInterval, _ f: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if f() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    }
    XCTFail("timed out waiting for \(what)")
    return false
  }

  func shot(_ dir: String?, _ name: String) {
    let s = XCUIScreen.main.screenshot()
    let a = XCTAttachment(screenshot: s)
    a.name = name
    a.lifetime = .keepAlways
    add(a)
    if let dir { try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(path: "\(name).png")) }
  }
}
