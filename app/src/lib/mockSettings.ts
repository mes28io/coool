// The Settings page's mock (`pnpm dev`): every SettingsBackend call, with state that lasts for the page's life.
// `?cli=broken` shows Codex installed but failing to start; `?notify=denied` a denied notification permission
// (`allowed` / `unavailable` the others); `?login=enabled|approval|not_found|unavailable` the login item's states;
// `?onboarding=1` shows the first-run onboarding (otherwise the mock counts it as seen, so other demos never see it).

import type { AppPrefs, Connections, InstalledApp, LidStatus, LoginStatus, NotifyPermission, SettingsBackend, StorageStatus, Worktrees } from "./settingsTypes";

const HOME = "/Users/you";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = "coool.mock.prefs";

function loadPrefs(): AppPrefs {
  const d: AppPrefs = { confirm_quit: true, prevent_sleep: false, notify: { needs_you: true, finished: false, failed: true, sound: true, only_unfocused: true, custom_sounds: false, sound_needs: "coool:rise", sound_finished: "coool:tap", sound_failed: "coool:knock" }, open_with: "system", building: [], menubar: { show: true, mode: "cpu" }, keep_chats: true };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v ? { ...d, ...v, notify: { ...d.notify, ...v.notify } } : d;
  } catch {
    return d;
  }
}

const APPS: InstalledApp[] = [
  { id: "vscode", name: "VS Code", path: "/Applications/Visual Studio Code.app" },
  { id: "cursor", name: "Cursor", path: "/Applications/Cursor.app" },
  { id: "zed", name: "Zed", path: "/Applications/Zed.app" },
  { id: "xcode", name: "Xcode", path: "/Applications/Xcode.app" },
  { id: "terminal", name: "Terminal", path: "/System/Applications/Utilities/Terminal.app" },
  { id: "ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
];

function connections(project: string | null): Connections {
  const cj = `${HOME}/.claude.json`;
  const cs = `${HOME}/.claude/settings.json`;
  const cfg = `${HOME}/.codex/config.toml`;
  const pm = project ? `${project}/.mcp.json` : null;
  return {
    claude: {
      files: [
        { path: cj, label: "User MCP servers", exists: true },
        { path: cs, label: "User settings", exists: true },
        { path: `${HOME}/.claude/plugins/installed_plugins.json`, label: "Installed plugins", exists: true },
        ...(project
          ? [
              { path: `${project}/.mcp.json`, label: "Project .mcp.json", exists: true },
              { path: `${project}/.claude/settings.json`, label: "Project settings", exists: true },
              { path: `${project}/.claude/settings.local.json`, label: "Project local settings", exists: false },
            ]
          : []),
      ],
      mcp: [
        { name: "github", scope: "user", transport: "stdio", command: "npx -y @modelcontextprotocol/server-github", url: null, env_keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"], header_keys: [], disabled: false, file: cj },
        { name: "linear", scope: "user", transport: "http", command: null, url: "https://mcp.linear.app/mcp", env_keys: [], header_keys: ["Authorization"], disabled: false, file: cj },
        { name: "sentry", scope: "user", transport: "sse", command: null, url: "https://mcp.sentry.dev/sse?token=••••", env_keys: [], header_keys: [], disabled: false, file: cj },
        ...(pm ? [{ name: "postgres", scope: "project", transport: "stdio", command: "uvx mcp-server-postgres --dsn ••••", url: null, env_keys: ["PGPASSWORD"], header_keys: [], disabled: true, file: pm }] : []),
      ],
      hooks: [
        { event: "PostToolUse", matcher: "Edit|Write", command: "pnpm -s prettier --write \"$CLAUDE_FILE_PATHS\"", file: cs },
        { event: "Stop", matcher: null, command: "afplay /System/Library/Sounds/Glass.aiff", file: cs },
        ...(project ? [{ event: "PreToolUse", matcher: "Bash", command: "./scripts/guard.sh", file: `${project}/.claude/settings.json` }] : []),
      ],
      plugins: [
        { name: "commit-commands", source: "claude-code-plugins", enabled: true, version: "1.2.0", file: cs },
        { name: "pr-review-toolkit", source: "claude-code-plugins", enabled: true, version: "0.9.1", file: cs },
        { name: "frontend-design", source: "anthropic-agent-skills", enabled: false, version: "1.0.0", file: `${HOME}/.claude/plugins/installed_plugins.json` },
      ],
      errors: [],
    },
    codex: {
      files: [{ path: cfg, label: "Codex config", exists: true }],
      mcp: [
        { name: "context7", scope: "user", transport: "stdio", command: "npx -y @upstash/context7-mcp --api-key ••••", url: null, env_keys: [], header_keys: [], disabled: false, file: cfg },
        { name: "figma", scope: "user", transport: "http", command: null, url: "http://127.0.0.1:3845/mcp", env_keys: [], header_keys: [], disabled: false, file: cfg },
      ],
      hooks: [{ event: "notify", matcher: null, command: "terminal-notifier -title Codex", file: cfg }],
      plugins: [],
      errors: [],
    },
  };
}

function worktrees(project: string): Worktrees {
  const wt = (name: string, o: Partial<Worktrees["list"][number]>) => ({
    path: `${project}/.claude/worktrees/${name}`,
    branch: `worktree-${name}`,
    head: "3f9c2e1",
    main: false,
    agent: true,
    merged: false,
    dirty: false,
    locked: false,
    prunable: false,
    bytes: 412_000_000,
    removable: false,
    why_not: "Not merged into main",
    ...o,
  });
  return {
    git: "git version 2.50.1",
    root: project,
    main_branch: "main",
    error: null,
    list: [
      { path: project, branch: "main", head: "80729c3", main: true, agent: false, merged: true, dirty: true, locked: false, prunable: false, bytes: 1_840_000_000, removable: false, why_not: "The main worktree" },
      wt("agent-settings", { head: "a41d0b7", bytes: 388_000_000, dirty: true, why_not: "Has uncommitted changes" }),
      wt("agent-usage-rings", { head: "0330376", merged: true, removable: true, why_not: null, bytes: 352_000_000 }),
      wt("agent-pilot-warm", { head: "3a1d8bc", merged: true, removable: true, why_not: null, bytes: 401_000_000 }),
      wt("agent-mac-vm", { head: "c77e0a2", bytes: 2_310_000_000 }),
    ],
  };
}

export function mockSettings(sim: { shutdown(udid: string): Promise<void> }): SettingsBackend {
  let prefs = loadPrefs();
  const q = typeof location !== "undefined" ? location.search : "";
  const knob = (k: string) => new RegExp(`[?&]${k}=([\\w-]+)`).exec(q)?.[1] ?? "";
  const NO_BUNDLE = "This build of coool has no app bundle, so macOS won't show its notifications.";
  let perm: NotifyPermission =
    knob("notify") === "denied" ? { status: "denied" } : knob("notify") === "allowed" ? { status: "authorized" } : knob("notify") === "unavailable" ? { status: "unavailable", reason: NO_BUNDLE } : { status: "not_determined" };
  const loginKnob: Record<string, LoginStatus> = { enabled: { status: "enabled" }, approval: { status: "requires_approval" }, not_found: { status: "not_found" }, unavailable: { status: "unavailable", reason: "Login items are macOS only for now." } };
  let login: LoginStatus = loginKnob[knob("login")] ?? { status: "not_registered" };
  let onboarded = knob("onboarding") !== "1";
  const removed = new Set<string>();
  // "Keep working with the lid closed": `?lid=missing|ready|display|holding|grace|battery|hot|stale` (any value opens
  // Settings > General on the row; anything but `missing` turns the setting on). `?lid=chat`: on and ready, the app
  // left where it opens (the "this chat asks" line above a working chat's message box). With any knob, the first chat
  // waiting on a permission is named in a `waiting` stop (the Settings stop list, the Needs you header).
  const lidKnob = knob("lid");
  let lidWaiter: () => { key: string; title: string; request: string; chat: number | null } | null = () => null;
  if (lidKnob) {
    prefs = { ...prefs, lid: { enabled: lidKnob !== "missing" || /[?&]lidon=1/.test(q), only_on_power: true, min_battery: 20, max_hours: 8, grace_mins: 2 } };
    void Promise.all([import("../store"), import("./chat"), import("./format")]).then(([{ useStore }, { useChats }, { displayTitle }]) => {
      lidWaiter = () => {
        for (const c of Object.values(useChats.getState().chats)) {
          if (!c.pendingPermission) continue;
          const s = useStore.getState().sessions.find((x) => x.chat === c.id || (c.sessionId != null && x.id === c.sessionId));
          if (s) return { key: `${s.provider}:${s.id}`, title: displayTitle(s), request: c.pendingPermission, chat: c.id };
        }
        // No chat asks yet: a session blocked in its terminal (also a Needs you item).
        const t = useStore.getState().sessions.find((x) => x.waiting_for && x.status !== "ended");
        return t ? { key: `${t.provider}:${t.id}`, title: displayTitle(t), request: "", chat: null } : null;
      };      if (lidKnob === "chat") return;
      setTimeout(() => {
        useStore.getState().openSettings("general");
        setTimeout(() => document.querySelector('[data-setting="lid-awake"]')?.scrollIntoView({ block: "start" }), 400);
      }, 300);
    });
  }
  // The waiting stop keeps the time it was first seen.
  let lidWaitAt = 0;
  let lidHelper: LidStatus["helper"] = lidKnob === "missing" || lidKnob === "display" ? { state: "missing" } : lidKnob === "stale" ? { state: "unreachable", detail: "Connection refused" } : { state: "ready" };
  const lidStatus = (): LidStatus => {
    const p = prefs.lid ?? { enabled: false, only_on_power: true, min_battery: 20, max_hours: 8, grace_mins: 2 };
    const now = Date.now();
    const reading: LidStatus["reading"] = { on_battery: lidKnob === "battery", battery_pct: lidKnob === "battery" ? 64 : 100, thermal: lidKnob === "hot" ? "serious" : "nominal", lid_closed: false, lid_sleeps: lidKnob !== "display", sleep_disabled: lidKnob === "holding" || lidKnob === "stale" || lidKnob === "grace" };
    const working = p.enabled && ["holding", "display", "battery", "hot"].includes(lidKnob) ? 2 : 0;
    const grace = p.enabled && lidKnob === "grace";
    const via = grace ? "helper" : !p.enabled || !working ? null : lidKnob === "holding" && lidHelper.state === "ready" ? "helper" : lidKnob === "display" ? "display" : null;
    const blocked = !p.enabled || !working || via ? null : lidKnob === "battery" ? "on_battery" : lidKnob === "hot" ? "hot" : lidHelper.state !== "ready" ? "needs_helper" : null;
    const w = lidWaiter();
    if (w && !lidWaitAt) lidWaitAt = now - 7 * 60_000;
    const stops: LidStatus["stops"] = [
      ...(lidKnob === "hot" ? [{ at: now - 4 * 60_000, code: "hot" as const, detail: "the Mac is running hot" }] : []),
      ...(w ? [{ at: lidWaitAt, code: "waiting" as const, detail: `“${w.title}” was waiting for your answer (Bash: npm test)`, chat: w.chat, session: w.key, request: w.request }] : []),
      ...(lidKnob === "battery" ? [{ at: now - 11 * 60_000, code: "on_battery" as const, detail: "on battery" }] : []),
      { at: now - 9 * 3_600_000, code: "low_battery", detail: "battery 20%" },
    ];
    return {
      enabled: p.enabled,
      helper: lidHelper,
      dry_run: false,
      via,
      blocked,
      working,
      waiting: grace ? 1 : 0,
      grace_until: grace ? now + 100_000 : null,
      grace_title: grace ? (w?.title ?? "Offline sync queue") : null,
      since: via ? now - 72 * 60_000 : null,
      reading,
      stops: lidKnob ? stops : [],
      stale: lidKnob === "stale",
      error: null,
      prefs: p,
    };
  };
  const storage: StorageStatus = {
    items: [
      { id: "transcripts", label: "Transcript cache", desc: "Parsed transcripts, so the sidebar loads fast. Rebuilt from the CLIs' own files.", path: `${HOME}/Library/Caches/coool`, bytes: 96_400_000, files: 1312, clearable: true, clear_label: "Clear cache" },
      { id: "webcache", label: "Web view cache", desc: "The app's own web view cache.", path: `${HOME}/Library/Caches/coool/WebKit`, bytes: 18_200_000, files: 210, clearable: false, clear_label: null },
      { id: "pilot_memory", label: "Pilot memory", desc: "Learned routes and muscle memory for the device pilot.", path: `${HOME}/Library/Application Support/sh.coool.app/pilot`, bytes: 61_440, files: 3, clearable: true, clear_label: "Forget learned routes" },
      { id: "pilot_log", label: "Pilot decision log", desc: "The pilot's decision log, kept for training.", path: `${HOME}/Library/Application Support/sh.coool.app/pilot`, bytes: 184_320, files: 1, clearable: true, clear_label: "Delete log" },
      { id: "helper", label: "Device helper", desc: "The device helper coool installs into the simulator.", path: `${HOME}/Library/Application Support/sh.coool.app/bin`, bytes: 9_800_000, files: 41, clearable: false, clear_label: null },
      { id: "settings", label: "Settings", desc: "Your coool preferences and the list of sessions coool started.", path: `${HOME}/Library/Application Support/coool`, bytes: 24_576, files: 3, clearable: false, clear_label: null },
    ],
    simulator: { udid: "MOCK-COOOL-1", name: "coool iPhone", state: "Shutdown", runtime: "iOS 27.0", device_type: "iPhone 18 Pro", bytes: 2_140_000_000 },
  };
  const copy = (): StorageStatus => JSON.parse(JSON.stringify(storage));
  return {
    async prefsGet() {
      await wait(60);
      return JSON.parse(JSON.stringify(prefs));
    },
    async prefsSet(p) {
      // Switching the lid hold off removes its helper (as the backend does).
      if (prefs.lid?.enabled && p.lid && !p.lid.enabled) lidHelper = { state: "missing" };
      prefs = { ...JSON.parse(JSON.stringify(p)), lid: p.lid ?? prefs.lid };
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {}
    },
    async powerStatus() {
      const covered = lidStatus().via === "helper";
      return { enabled: prefs.prevent_sleep, held: prefs.prevent_sleep && !covered, working: 2, failed: false, covered };
    },
    async lidStatus() {
      return lidStatus();
    },
    async lidInstall() {
      await wait(900);
      lidHelper = { state: "ready" };
      return lidStatus();
    },
    async lidRemove() {
      await wait(400);
      lidHelper = { state: "missing" };
      return lidStatus();
    },
    async lidRestore() {
      await wait(400);
      return { ...lidStatus(), stale: false };
    },
    async notifyPermission() {
      return { ...perm };
    },
    async notifyRequest() {
      await wait(500);
      if (perm.status === "not_determined") perm = { status: "authorized" };
      return { ...perm };
    },
    async notifyTest() {
      await wait(200);
      if (perm.status !== "authorized") throw new Error("Notifications are off for coool in System Settings.");
    },
    async notifySounds() {
      return { coool: ["rise", "tap", "glass", "knock", "marimba", "chirp", "ticks"], system: ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"], bundled: false };
    },
    async notifySoundPreview(id) {
      return `mock: ${id}`;
    },
    async loginStatus() {
      return { ...login };
    },
    async loginSet(enabled) {
      await wait(250);
      login = { status: enabled ? "enabled" : "not_registered" };
      return { ...login };
    },
    async appsInstalled() {
      await wait(80);
      return APPS.map((a) => ({ ...a }));
    },
    async openPath() {},
    async openSystemSettings() {},
    async onboardingSeen() {
      await wait(40);
      return onboarded;
    },
    async onboardingSetSeen(seen) {
      onboarded = seen;
    },
    async cliStatus() {
      await wait(700);
      const broken = q.includes("cli=broken");
      return [
        { provider: "claude", name: "Claude Code", found: true, path: `${HOME}/.local/bin/claude`, version: "2.1.14", error: null, fix: null, install: "curl -fsSL https://claude.ai/install.sh | bash" },
        broken
          ? { provider: "codex", name: "Codex", found: true, path: "/opt/homebrew/bin/codex", version: null, error: "Codex is installed but won't start: env: node: No such file or directory", fix: "brew reinstall codex", install: "brew upgrade codex" }
          : { provider: "codex", name: "Codex", found: true, path: "/opt/homebrew/bin/codex", version: "0.98.0", error: null, fix: null, install: "brew upgrade codex" },
      ];
    },
    async connections(project) {
      await wait(150);
      return connections(project);
    },
    async openConfigFile() {},
    async worktreesList(project) {
      await wait(500);
      const w = worktrees(project);
      return { ...w, list: w.list.filter((x) => !removed.has(x.path)) };
    },
    async worktreeRemove(project, path) {
      await wait(600);
      const w = worktrees(project).list.find((x) => x.path === path);
      if (!w?.removable) throw new Error(w?.why_not ?? "Not a worktree of this project");
      removed.add(path);
      return this.worktreesList(project);
    },
    async storageStatus() {
      await wait(300);
      return copy();
    },
    async storageClear(id) {
      await wait(300);
      const it = storage.items.find((i) => i.id === id);
      if (!it?.clearable) throw new Error(`"${id}" can't be cleared here`);
      it.bytes = 0;
      it.files = 0;
      return copy();
    },
    async simErase(udid) {
      await sim.shutdown(udid);
      await wait(900);
      if (storage.simulator) storage.simulator.bytes = 412_000_000;
    },
  };
}
