// Debug builds only: invented data for screenshots (`--demo <screen>`). Nothing here talks to a relay.

#if DEBUG
  import Foundation
  import RemoteProtocol

  @MainActor
  enum Demo {
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
      s.macLastSeen = Int64(now) - 20_000
      let sessions = [
        SessionInfo(id: "chat:1", title: "Why do invoices from March show the wrong month?", project: "invoices", cli: .claude, state: "waiting", lastActivity: now - 40_000, chat: true),
        SessionInfo(id: "chat:2", title: "Add rate limiting to /v2/search", project: "atlas-api", cli: .claude, state: "working", lastActivity: now - 5_000, chat: true),
        SessionInfo(id: "chat:3", title: "Audit the /v2 routes for missing auth checks", project: "atlas-api", cli: .codex, state: "working", lastActivity: now - 20_000, chat: true),
        SessionInfo(id: "chat:4", title: "Return 429 with a Retry-After header", project: "atlas-api", cli: .claude, state: "idle", lastActivity: now - 720_000, chat: true),
        SessionInfo(id: "codex:9", title: "Port the shader pipeline to wgpu", project: "pixelforge", cli: .codex, state: "ended", lastActivity: now - 7_200_000, chat: false),
        SessionInfo(id: "chat:5", title: "Which storage should the notes sync use?", project: "notes-ios", cli: .claude, state: "waiting", lastActivity: now - 90_000, chat: true),
      ]
      s.sessions = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
      s.needs = [
        Need(id: "1:a", session: "chat:1", kind: "permission", tool: "Bash", summary: "rm -rf node_modules/.cache dist && npm test", command: "rm -rf node_modules/.cache dist && npm test", explanation: "Clear the build cache and run the unit tests"),
        Need(id: "5:b", session: "chat:5", kind: "question", tool: "Question", summary: "", questions: [Question(question: "Which storage should the notes sync use?", options: ["CloudKit", "SQLite with a custom sync", "Keep it local for now"], multi: false, allowOther: true)]),
      ]
      s.unseen = ["5:b"]
      s.projects = [Project(id: "a", name: "atlas-api"), Project(id: "b", name: "invoices"), Project(id: "c", name: "notes-ios"), Project(id: "d", name: "pixelforge")]
      s.tails["chat:2"] = [
        ChatItem(role: "user", text: "Add rate limiting to /v2/search: 60 requests a minute per API key, 429 with Retry-After."),
        ChatItem(role: "tool", text: "src/routes/search.rs", tool: "Read"),
        ChatItem(role: "tool", text: "token bucket", tool: "Grep"),
        ChatItem(role: "assistant", text: "There's no limiter yet. I'll add a token bucket keyed by API key in `middleware/rate_limit.rs` and wire it into the `/v2` router."),
        ChatItem(role: "tool", text: "src/middleware/rate_limit.rs", tool: "Write"),
        ChatItem(role: "notice", text: "Allowed Bash from Ada's iPhone"),
        ChatItem(role: "tool", text: "cargo test -p api rate_limit", tool: "Bash"),
        ChatItem(role: "assistant", text: "The limiter is in and its tests pass. Now reading the budgets from config so they follow reloads."),
      ]
    }
  }
#endif
