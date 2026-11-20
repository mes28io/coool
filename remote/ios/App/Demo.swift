// Debug builds only: invented data for screenshots (`--demo <screen>`). Nothing here talks to a relay.

#if DEBUG
  import Foundation
  import RemoteProtocol
  import UIKit

  @MainActor
  enum Demo {
    /// The value after a launch argument (`--e2e-audio <path>`).
    static func arg(_ name: String) -> String? {
      let a = ProcessInfo.processInfo.arguments
      guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
      return a[i + 1]
    }

    /// Screenshots of the composer's states (`--compose text|attachments|recording|transcribing|slash|error`).
    static func compose(_ store: RemoteStore, session: String, text: inout String, atts: inout [Attachment], voice: VoiceCapture, error: inout String?) {
      guard store.demo, let state = arg("--compose") else { return }
      switch state {
      case "text": text = "Also cover the 429 path in the integration tests"
      case "attachments":
        text = "Does the limiter match this sketch?"
        atts = [Attachment(image: sketch(), name: "sketch.jpg"), Attachment(image: frame(), name: "screen.png"), Attachment(file: Data("[limits]\nper_minute = 60\n".utf8), name: "limits.toml")]
      case "recording": voice.pretend(.recording)
      case "transcribing": voice.pretend(.transcribing)
      case "slash": text = "/re"
      case "error": error = "Your Mac refused the attachment: only PDFs and text files can be sent"
      default: break
      }
    }

    /// The Mac's side of a demo send: its copy of the message a moment later, then (for a message) a reply that
    /// streams in about once a second, as the Mac packs it.
    static func echo(_ s: RemoteStore, _ o: Outgoing) {
      let id = o.session
      Task { @MainActor in
        try? await Task.sleep(for: .milliseconds(700))
        if o.isNote {
          var live = s.logs[id]?.live ?? ChatLive(state: "working")
          live.notes = (live.notes ?? []) + [LiveNote(id: randomId(), text: o.text, state: "queued")]
          s.took(ChatUpdate(session: id, items: [], live: live))
          return
        }
        let k = "u:\(randomId())"
        s.took(ChatUpdate(session: id, items: [LiveItem(k: k, role: "user", text: o.text)], live: ChatLive(state: "working", thinking: true, tally: Tally(steps: 0, since: Double(nowMs())))))
        let reply = "Here is the plan:\n\n1. Add a `RetryPolicy` with exponential backoff (200 ms, doubling, at most 5 tries) and jitter.\n2. Wrap each upload attempt and log the attempt number, the status and the delay.\n3. Stop retrying on 4xx except 429, which honours `Retry-After`.\n\nI'll start with the policy and its tests, then wire it into the client so every call site gets it for free."
        let words = reply.split(separator: " ", omittingEmptySubsequences: false)
        var n = 0
        while n < words.count {
          try? await Task.sleep(for: .milliseconds(950))
          n = min(words.count, n + 9)
          s.took(ChatUpdate(session: id, items: [], live: ChatLive(state: "working", text: words[..<n].joined(separator: " "), tally: Tally(steps: 0, since: Double(nowMs())))))
        }
        try? await Task.sleep(for: .milliseconds(700))
        s.took(ChatUpdate(session: id, items: [LiveItem(k: "a:\(randomId())", role: "assistant", text: reply)], live: ChatLive(state: "idle", tally: Tally(steps: 0))))
      }
    }

    static func store(_ screen: String) -> RemoteStore {
      let s = RemoteStore()
      s.demo = true
      switch screen {
      case "pairing": s.phase = .unpaired
      case "revoked":
        s.phase = .unpaired
        s.revokedNotice = "This iPhone was removed in coool on your Mac, so it can no longer see or steer your sessions. To use Remote again, pair it once more: on the Mac, open Settings > Remote > Pair an iPhone."
      case "code":
        s.phase = .claiming
        s.claimState = .waiting(code: "851623")
      case "offline":
        fill(s)
        s.macLastSeen = Int64(nowMs()) - 3_600_000 * 3
      case "empty":
        fill(s)
        s.sessions = [:]
        s.needs = []
        s.overview = Overview()
      default:
        fill(s)
      }
      return s
    }

    static func fill(_ s: RemoteStore) {
      let now = Double(nowMs())
      s.phase = .paired
      s.mac = PairedMac(relay: "https://example.convex.cloud", name: "Ada's iPhone", deviceId: randomId(), identity: .generate(), macId: "00112233445566778899aabbccddeeff", macSignPub: "", macBoxPub: "", pairedAt: Int64(now) - 86_400_000 * 3)
      s.live = true
      s.macMinor = 1
      s.macLastSeen = Int64(now) - 20_000
      let sessions = [
        SessionInfo(id: "chat:1", title: "Why do invoices from March show the wrong month?", project: "invoices", cli: .claude, state: "waiting", lastActivity: now - 40_000, chat: true),
        SessionInfo(id: "chat:2", title: "Add rate limiting to /v2/search", project: "atlas-api", cli: .claude, state: "working", model: "claude-sonnet", lastActivity: now - 5_000, chat: true, step: "Edit · src/middleware/rate_limit.rs", agents: 2, steps: 14, turnStarted: now - 192_000),
        SessionInfo(id: "chat:3", title: "Audit the /v2 routes for missing auth checks", project: "atlas-api", cli: .codex, state: "working", lastActivity: now - 20_000, chat: true, step: "Bash · rg -n \"fn handler\" src/routes", steps: 6, turnStarted: now - 64_000),
        SessionInfo(id: "chat:4", title: "Return 429 with a Retry-After header", project: "atlas-api", cli: .claude, state: "idle", lastActivity: now - 720_000, chat: true),
        SessionInfo(id: "codex:9", title: "Port the shader pipeline to wgpu", project: "pixelforge", cli: .codex, state: "ended", lastActivity: now - 7_200_000, chat: false),
        SessionInfo(id: "chat:5", title: "Which storage should the notes sync use?", project: "notes-ios", cli: .claude, state: "waiting", lastActivity: now - 90_000, chat: true),
        SessionInfo(id: "chat:6", title: "Sketch the onboarding plan", project: "notes-ios", cli: .claude, state: "waiting", lastActivity: now - 150_000, chat: true),
        SessionInfo(id: "claude:8", title: "Fix the flaky upload test", project: "invoices", cli: .claude, state: "ended", lastActivity: now - 86_400_000, chat: false),
      ]
      s.sessions = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
      s.needs = [
        Need(id: "1:a", session: "chat:1", kind: "permission", tool: "Bash", summary: "rm -rf node_modules/.cache dist && npm test", command: "rm -rf node_modules/.cache dist && npm test", explanation: "Clear the build cache and run the unit tests", risk: "Deletes files recursively", what: "Run a command", read: AiRead(what: "Deletes two build folders, then runs the test suite.", why: "The cached build still has the old date parser, so the tests would pass on stale code.", check: ["Both folders are inside the project", "Nothing outside it is touched"])),
        Need(id: "2:e", session: "chat:2", kind: "permission", tool: "Edit", summary: "src/middleware/rate_limit.rs", command: "src/middleware/rate_limit.rs", what: "Edit a file", diff: Diff(path: "src/middleware/rate_limit.rs", before: "pub fn limit(key: &str) -> bool {\n    // TODO: real budget\n    true\n}", after: "pub fn limit(key: &str, budget: &Budget) -> bool {\n    let bucket = BUCKETS.entry(key);\n    bucket.take(1, budget.per_minute)\n}")),
        Need(id: "5:b", session: "chat:5", kind: "question", tool: "Question", summary: "", questions: [Question(question: "Which storage should the notes sync use?", options: ["CloudKit", "SQLite with a custom sync", "Keep it local for now"], multi: false, allowOther: true)], what: "A question"),
        Need(id: "6:p", session: "chat:6", kind: "plan", tool: "ExitPlanMode", summary: "Onboarding in three screens", what: "Approve a plan", plan: "# Onboarding in three screens\n\n1. **Welcome**: one line on what the app does, and *Continue*.\n2. **Sync**: CloudKit on by default, with a plain-words note.\n3. **First note**: an example note the person can keep or delete.\n\n## Not in this pass\n- Account sign-in\n- Import from other apps\n\n```swift\nstruct OnboardingView: View { … }\n```"),
      ]
      s.unseen = ["5:b", "6:p"]
      s.projects = [Project(id: "a", name: "atlas-api"), Project(id: "b", name: "invoices"), Project(id: "c", name: "notes-ios"), Project(id: "d", name: "pixelforge")]
      s.options = StartOptions(
        claude: .init(models: [.init(id: "opus", label: "Opus (latest)"), .init(id: "sonnet", label: "Sonnet (latest)"), .init(id: "haiku", label: "Haiku (latest)")], modes: [.init(id: "default", label: "Ask me before each change"), .init(id: "acceptEdits", label: "Edit files freely, ask before commands"), .init(id: "plan", label: "Plan first, change nothing until I say")], model: "sonnet", mode: "default"),
        codex: .init(models: [.init(id: "gpt-5-codex", label: "GPT-5 Codex")], modes: [.init(id: "untrusted", label: "Ask me before anything that isn’t plainly safe"), .init(id: "on-request", label: "Work on its own, ask when it needs to")], mode: "untrusted"))
      s.overview = Overview(projects: [
        .init(name: "atlas-api", working: 2, idle: 1, sessions: ["chat:2", "chat:3", "chat:4"],
              agents: [.init(session: "chat:2", agents: [.init(label: "Find every /v2 route", step: "Grep · fn handler"), .init(label: "Read the config loader", step: "Read · src/config.rs")])],
              changes: [
                .init(session: "chat:2", kind: "edit", action: "Edited", object: "src/middleware/rate_limit.rs", times: 3, ts: now - 30_000),
                .init(session: "chat:2", kind: "create", action: "Wrote", object: "tests/rate_limit.rs", ts: now - 95_000),
                .init(session: "chat:3", kind: "edit", action: "Edited", object: "src/routes/search.rs", ts: now - 140_000),
                .init(session: "chat:4", kind: "commit", action: "Committed", object: "Return 429 with Retry-After", ts: now - 700_000),
                .init(session: "chat:4", kind: "push", action: "Pushed", object: "feature/limits", ts: now - 690_000),
              ],
              overlaps: [.init(file: "src/routes/search.rs", sessions: ["chat:2", "chat:3"], titles: ["Add rate limiting to /v2/search", "Audit the /v2 routes"], ts: now - 140_000)],
              commits: [.init(short: "4f2a91c", subject: "Return 429 with a Retry-After header", ts: now - 700_000, files: 3), .init(short: "b81e0d4", subject: "Split the search handler", ts: now - 7_200_000, files: 5), .init(short: "0c77a12", subject: "Merge branch 'feature/pagination'", ts: now - 86_400_000, files: 9, merge: true)],
              branch: "feature/limits"),
        .init(name: "invoices", needs: 1, sessions: ["chat:1"], changes: [.init(session: "chat:1", kind: "edit", action: "Edited", object: "src/dates.ts", ts: now - 60_000)], branch: "main"),
        .init(name: "notes-ios", needs: 2, sessions: ["chat:5", "chat:6"], branch: "main"),
      ], usage: [
        "claude": .init(plan: "Max", windows: [.init(label: "Current session", kind: "session", percent: 64, resets: now + 2 * 3_600_000), .init(label: "Weekly", kind: "weekly", percent: 31, resets: now + 3 * 86_400_000)]),
        "codex": .init(plan: "Plus", windows: [.init(label: "5 h", kind: "session", percent: 12, resets: now + 4 * 3_600_000), .init(label: "Weekly", kind: "weekly", percent: 48, resets: now + 5 * 86_400_000)]),
      ])
      var log = LiveLog()
      log.apply(ChatUpdate(session: "chat:2", items: [
        LiveItem(k: "u1", role: "user", text: "Add rate limiting to /v2/search: 60 requests a minute per API key, 429 with Retry-After. The sketch is attached.", images: [ImageRef(key: "demo-sketch", name: "sketch.jpg")]),
        LiveItem(k: "t1", role: "tool", text: "src/routes/search.rs", tool: "Read", ok: true),
        LiveItem(k: "t2", role: "tool", text: "token bucket", tool: "Grep", ok: true),
        LiveItem(k: "a1", role: "assistant", text: "There's no limiter yet. I'll add a **token bucket** keyed by API key in `middleware/rate_limit.rs` and wire it into the `/v2` router."),
        LiveItem(k: "g1", role: "agent", text: "Find every /v2 route", tool: "Task", steps: 7),
        LiveItem(k: "t3", role: "tool", text: "src/middleware/rate_limit.rs", tool: "Edit", ok: true, diff: Diff(path: "src/middleware/rate_limit.rs", before: "pub fn limit(key: &str) -> bool {\n    // TODO: real budget\n    true\n}", after: "pub fn limit(key: &str, budget: &Budget) -> bool {\n    let bucket = BUCKETS.entry(key);\n    bucket.take(1, budget.per_minute)\n}")),
        LiveItem(k: "n1", role: "notice", text: "Allowed Bash from Ada's iPhone"),
        LiveItem(k: "t4", role: "tool", text: "cargo test -p api rate_limit", tool: "Bash"),
      ], reset: true, live: ChatLive(state: "working", text: "The limiter is in and its tests pass. Now reading the budgets from config so they", step: "Bash · cargo test -p api rate_limit", agents: [LiveAgent(id: "g1", label: "Find every /v2 route", steps: 7, done: true), LiveAgent(id: "g2", label: "Read the config loader", steps: 4, step: "Read · src/config.rs")], tally: Tally(steps: 14, edits: 3, since: now - 192_000), devices: ["browser"], notes: [LiveNote(id: "n-demo", text: "Keep the old limit for the /health route", state: "queued")]), meta: meta(cli: "claude", model: "claude-sonnet")))
      s.logs["chat:2"] = log
      var idle = LiveLog()
      idle.apply(ChatUpdate(session: "chat:4", items: [
        LiveItem(k: "u1", role: "user", text: "Return 429 with a Retry-After header when the limiter says no."),
        LiveItem(k: "t1", role: "tool", text: "src/middleware/rate_limit.rs", tool: "Edit", ok: true),
        LiveItem(k: "a1", role: "assistant", text: "Done: a refused request now gets **429** and `Retry-After` set to the seconds until the bucket refills. The tests cover both."),
      ], reset: true, live: ChatLive(state: "idle", tally: Tally(steps: 3, edits: 1)), meta: meta(cli: "claude", model: "haiku")))
      s.logs["chat:4"] = idle
      s.images["demo-sketch"] = sketch()
      s.frames["chat:2|browser"] = (frame(), 12, Date().addingTimeInterval(-1))
      s.recents = [
        .init(text: "Run the search benchmarks and tell me what got slower", project: "a", projectName: "atlas-api", cli: .claude, model: "sonnet", mode: "default", at: now / 1000 - 3600),
        .init(text: "Write the release notes for 2.4 from the merged PRs", project: "b", projectName: "invoices", cli: .claude, model: "haiku", mode: "plan", at: now / 1000 - 86_400),
      ]
    }

    static func meta(cli: String, model: String) -> ChatMeta {
      ChatMeta(cli: cli, model: model, models: [.init(id: "opus", label: "Opus"), .init(id: "claude-sonnet", label: "Sonnet"), .init(id: "haiku", label: "Haiku")], mode: "default", modeLabel: "Ask before edits", context: 84_000, window: 200_000, ladder: .init(on: true, tiers: ["haiku", "sonnet"]), commands: [
        .init(name: "review", description: "Review the current changes", kind: "command"), .init(name: "compact", description: "Summarize the conversation to free context", hint: "[instructions]", kind: "command"),
        .init(name: "context", description: "Context used, as a ring", kind: "app"), .init(name: "model", description: "Switch the model", kind: "app"),
        .init(name: "release-notes", description: "Draft release notes from the merged PRs", kind: "skill"), .init(name: "resume", description: "Pick up a past conversation", kind: "terminal"),
        .init(name: "init", description: "Write a CLAUDE.md for this project", kind: "command"), .init(name: "security-review", description: "Look for security problems in the diff", kind: "skill"),
      ])
    }

    /// An invented whiteboard sketch for the chat's image.
    static func sketch() -> UIImage {
      let size = CGSize(width: 600, height: 420)
      return UIGraphicsImageRenderer(size: size).image { c in
        UIColor(white: 0.96, alpha: 1).setFill()
        c.fill(CGRect(origin: .zero, size: size))
        UIColor(white: 0.25, alpha: 1).setStroke()
        let p = UIBezierPath()
        p.lineWidth = 5
        for (x, y) in [(80.0, 300.0), (200.0, 160.0), (320.0, 230.0), (520.0, 90.0)] { if p.isEmpty { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) } }
        p.stroke()
        UIColor(red: 0.04, green: 0.52, blue: 1, alpha: 1).setFill()
        c.cgContext.fill(CGRect(x: 60, y: 340, width: 480, height: 14))
        ("60 / min" as NSString).draw(at: CGPoint(x: 70, y: 40), withAttributes: [.font: UIFont.systemFont(ofSize: 40, weight: .bold), .foregroundColor: UIColor(white: 0.2, alpha: 1)])
      }
    }

    /// An invented page in the Browser panel.
    static func frame() -> UIImage {
      let size = CGSize(width: 420, height: 300)
      return UIGraphicsImageRenderer(size: size).image { c in
        UIColor.white.setFill()
        c.fill(CGRect(origin: .zero, size: size))
        UIColor(white: 0.93, alpha: 1).setFill()
        c.fill(CGRect(x: 0, y: 0, width: 420, height: 34))
        ("localhost:8080/v2/search?q=lamp" as NSString).draw(at: CGPoint(x: 12, y: 9), withAttributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor.darkGray])
        ("429 Too Many Requests" as NSString).draw(at: CGPoint(x: 20, y: 70), withAttributes: [.font: UIFont.systemFont(ofSize: 26, weight: .bold), .foregroundColor: UIColor.black])
        ("Retry-After: 12" as NSString).draw(at: CGPoint(x: 20, y: 112), withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 15, weight: .regular), .foregroundColor: UIColor.darkGray])
        UIColor(red: 0.04, green: 0.52, blue: 1, alpha: 1).setFill()
        c.cgContext.fillEllipse(in: CGRect(x: 300, y: 200, width: 16, height: 16))
      }
    }
  }
#endif
