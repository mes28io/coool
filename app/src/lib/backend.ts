// One interface, two implementations: the Tauri shell, or a built-in mock
// when running in a plain browser (`pnpm dev`). See docs/APP_SPEC.md.

import { type DeltaWire, type FullWire, SessionsMerge, type Trace } from "./sessionsMerge";
import type { ChatEvent, ChatOptions, Environment, GitTrail, InsightsStatus, Provider, ResetOutcome, Snapshot } from "./types";
import type { MotionHints } from "./motion";
import type { SettingsBackend } from "./settingsTypes";

export interface PtyChunk {
  id: number;
  bytes: Uint8Array;
  /** Absolute end offset of this chunk in the PTY byte stream. */
  offset: number;
}

type Unlisten = () => void;

/** A command the current backend build does not have yet (wiring lands later). */
export class NotAvailable extends Error {
  constructor(public command: string) {
    super(`${command.replace(/_/g, " ")} is not available in this build of coool yet`);
    this.name = "NotAvailable";
  }
}
export const isNotAvailable = (e: unknown): e is NotAvailable => e instanceof NotAvailable;

export interface ChatBatch {
  id: number;
  events: ChatEvent[];
}

/** The Settings page's calls are in settingsTypes.ts. */
export interface Backend extends SettingsBackend {
  kind: "tauri" | "mock";
  listSessions(): Promise<Snapshot>;
  spawnSession(a: { provider: Provider; cwd: string; args?: string[]; rows: number; cols: number }): Promise<number>;
  resumeSession(a: { provider: Provider; sessionId: string; cwd: string; rows: number; cols: number }): Promise<number>;
  ptyWrite(id: number, data: string): Promise<void>;
  ptyResize(id: number, rows: number, cols: number): Promise<void>;
  ptyReplay(id: number): Promise<{ bytes: Uint8Array; offset: number }>;
  sendPrompt(id: number, text: string): Promise<void>;
  stopSession(a: { managed?: number | null; pid?: number | null }): Promise<void>;
  /** Stop a background shell (only a pid listed in some live session's `shells`). */
  stopShell(pid: number): Promise<void>;
  /** The session ids on screen: only their shells get output tails. */
  shellsFocus(ids: string[]): Promise<void>;
  pickFolder(): Promise<string | null>;
  environment(): Promise<Environment>;
  /** A project's recent git history for Mission control's commit trail (read-only; crates/core/src/gitlog.rs). Rejects when `path` is not in a repository. */
  gitTrail(path: string): Promise<GitTrail>;
  quit(): Promise<void>;
  onSessions(cb: (s: Snapshot) => void): Unlisten;
  onPtyOutput(cb: (c: PtyChunk) => void): Unlisten;
  onPtyExit(cb: (id: number) => void): Unlisten;
  onConfirmQuit(cb: () => void): Unlisten;
  /** Ask for a plan-usage reading now; the result arrives with a later `sessions` payload. */
  usageRefresh(provider: Provider): Promise<void>;
  /**
   * Spend one Codex rate-limit reset credit (only after the person confirms), then re-probe Codex usage.
   * `idempotencyKey` is one per attempt: reuse it when retrying that attempt so a retry never spends a second credit.
   */
  usageResetCodex(idempotencyKey: string): Promise<ResetOutcome>;

  // ---- chat sessions (CHAT_SPEC "Tauri contract additions") ----
  startChat(opts: ChatOptions): Promise<number>;
  chatSend(id: number, text: string): Promise<void>;
  chatInterrupt(id: number): Promise<void>;
  /** Steer a running turn: `now: false` delivers at the next step boundary, `now: true` interrupts the current step. Returns the note id. */
  chatSteer(id: number, text: string, now: boolean): Promise<string>;
  chatSteerCancel(id: number, noteId: string): Promise<void>;
  chatSetModel(id: number, model: string): Promise<void>;
  chatSetPermissionMode(id: number, mode: string): Promise<void>;
  /** `remember`: a `permission_request.remember` option id to apply (allows). */
  chatRespondPermission(id: number, requestId: string, allow: boolean, always: boolean, remember?: string | null): Promise<void>;
  /** Answers to a `question` event: per question, in order, the picked labels and/or typed text. */
  chatRespondQuestion(id: number, requestId: string, answers: string[][]): Promise<void>;
  chatStop(id: number): Promise<void>;
  chatReplay(id: number): Promise<{ events: ChatEvent[]; seq: number }>;
  /** Opens the chat's session in a PTY via resume; returns the PTY id. */
  openInTerminal(id: number): Promise<number>;
  onChatEvent(cb: (b: ChatBatch) => void): Unlisten;

  // ---- AI insights (CHAT_SPEC "AI insights") ----
  insightsStatus(): Promise<InsightsStatus>;
  insightsSetKey(key: string): Promise<void>;
  insightsClearKey(): Promise<void>;
  insightsSetEnabled(enabled: boolean): Promise<void>;

  /** Settings: "Show runs started by other tools" (persisted; echoed in `Snapshot.show_automation`). */
  setShowAutomation(enabled: boolean): Promise<void>;

  /** Settings: the device pilot's decision log, kept locally for training (APP_SPEC "Device pilot"). */
  pilotLogStatus(): Promise<PilotLogStatus>;
  pilotLogSetEnabled(enabled: boolean): Promise<PilotLogStatus>;
  /** Shows the log's folder in Finder. */
  pilotLogReveal(): Promise<void>;
  /** Deletes the decision logs (the muscle memory stays). */
  pilotLogDelete(): Promise<PilotLogStatus>;

  /** Device hints for "Reduce motion: Auto" (null when the build can't tell); pushed again when they change. */
  motionHints(): Promise<MotionHints | null>;
  onMotionHints(cb: (h: MotionHints) => void): Unlisten;

  /** Whether each artifact's local page is still on disk (by claude.ai URL). */
  artifactStatus(urls: string[]): Promise<Record<string, boolean>>;
  /** Opens the artifact's local copy in its preview window (or focuses the one showing it); false when the local copy is gone. */
  artifactWindow(url: string): Promise<boolean>;
  /** Open a claude.ai artifact link in the default browser (the opener plugin, scoped to https://claude.ai/*). */
  openArtifact(url: string): Promise<void>;

  // ---- In-app browser (APP_SPEC "Browser panel"; app/src-tauri/src/browser.rs) ----
  /** Whether web pages show in a native child webview (Tauri); the browser mock frames them instead. */
  nativeBrowser: boolean;
  /** Opens an http(s) page in a new child webview at `bounds` (CSS px of the window); returns its id. */
  browserOpen(url: string, bounds: BrowserBounds): Promise<string>;
  browserBounds(id: string, bounds: BrowserBounds): Promise<void>;
  browserNavigate(id: string, url: string): Promise<void>;
  browserGo(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
  /** Asks for a `browser-state` now (in-page navigations announce nothing). */
  browserPoll(id: string): Promise<void>;
  browserClose(id: string): Promise<void>;
  /** "Open in default browser": the page that webview shows, validated in Rust. */
  browserOpenExternal(id: string): Promise<void>;
  onBrowserState(cb: (s: BrowserState) => void): Unlisten;
  /** A webview the backend closed itself (too many alive). */
  onBrowserClosed(cb: (id: string) => void): Unlisten;
  /** A page asked for a new window that opens as a tab (`target=_blank`, `window.open` without a size); `id` is its panel webview. */
  onBrowserNewTab(cb: (t: { id: string; url: string }) => void): Unlisten;
  /** A chat's browser tabs, for its agent's `browser_*` tools (device/web.rs): they act on the active tab. */
  browserAgentSync(chat: number, tabs: BrowserAgentTab[], active: number | null): Promise<void>;
  /** The agent's tools asking the panel to open / show / switch / close a tab (lib/browserAgent.ts answers). */
  onBrowserAgent(cb: (r: BrowserAgentRequest) => void): Unlisten;
  /** A chat's agent acted on its browser panel (the panel shows it). */
  onBrowserActivity(cb: (a: BrowserActivity) => void): Unlisten;
  /** A `pilot_run` of a chat's agent, after each step and at its end (device/pilot). */
  onPilotProgress(cb: (p: PilotProgress) => void): Unlisten;

  // ---- iPhone: the iOS Simulator in the right panel (components/DevicePanel.tsx) ----
  /** The simulators (coool's own first); `available: false` with a reason when there is no Xcode / not macOS. */
  simDevices(): Promise<SimList>;
  /** Makes coool's own simulator ("coool iPhone") if there is none; returns its udid. */
  simEnsureDevice(): Promise<string>;
  /** Resolves once the device is booted. */
  simBoot(udid: string): Promise<void>;
  simShutdown(udid: string): Promise<void>;
  /** Streams the device's screen as JPEG frames to `onFrame` until `simDetach`; `w`/`h` in points. */
  simAttach(udid: string, onFrame: (jpeg: ArrayBuffer) => void): Promise<{ w: number; h: number; scale: number; stream: number }>;
  simDetach(udid: string, stream: number): Promise<void>;
  simInput(udid: string, input: SimInput): Promise<void>;
  /** The device a chat's agent tools act on (the one its panel shows); null unbinds. */
  simBind(chat: number, udid: string | null): Promise<void>;
  onSimActivity(cb: (a: SimActivity) => void): Unlisten;
  onSimState(cb: (s: { udid: string; state: string }) => void): Unlisten;

  // ---- Mac: a sandboxed macOS VM in the right panel (components/MacPanel.tsx) ----
  /** The VM's status; `available: false` with a reason when this Mac can't run it, `state: "absent"` before install. */
  macStatus(): Promise<MacStatus>;
  /** Downloads and installs macOS (~16 GB, 20+ min); progress arrives as `mac-state`. Resolves when done. */
  macInstall(): Promise<void>;
  /** Resolves once the Mac is up and ready (the first boot also runs setup; `mac-state.step` says what it is doing). */
  macBoot(): Promise<void>;
  macShutdown(): Promise<void>;
  /** Streams the guest screen as JPEG frames to `onFrame` (on change, plus one every ~2 s) until `macDetach`; `w`/`h` in guest pixels. */
  macAttach(onFrame: (jpeg: ArrayBuffer) => void): Promise<{ w: number; h: number; stream: number }>;
  macDetach(stream: number): Promise<void>;
  macInput(input: MacInput): Promise<void>;
  /** The Mac panel shows for this chat (`on`), or was closed: the chat's agent tools act on the Mac while bound. */
  macBind(chat: number, on: boolean): Promise<void>;
  /** A partial status (state, progress, step, error) to merge into the last `macStatus`. */
  onMacState(cb: (s: Partial<MacStatus>) => void): Unlisten;
}

export type MacState = "absent" | "downloading" | "installing" | "stopped" | "starting" | "setting-up" | "running" | "stopping";
export interface MacStatus {
  available: boolean;
  reason?: string;
  state: MacState;
  installed: boolean;
  provisioned: boolean;
  /** e.g. "macOS 27.0" */
  os?: string;
  cpus?: number;
  memoryMB?: number;
  /** Guest display size in pixels (1x). */
  w: number;
  h: number;
  /** Disk the VM uses on this Mac. */
  diskBytes?: number;
  /** Free space on the volume the VM lives on. */
  free?: number;
  /** Host folder shared into the guest (shows there as "/Volumes/My Shared Files"). */
  sharedDir?: string;
  progress?: { phase: string; fraction?: number; done?: number; total?: number };
  step?: string;
  error?: string;
}
/** Input to the guest, in guest display pixels (top-left origin). `code`: a macOS virtual key code (lib/macKeys.ts). */
export type MacInput =
  | { kind: "pointer"; x: number; y: number; buttons: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "keyDown"; code: number }
  | { kind: "keyUp"; code: number }
  | { kind: "text"; text: string };

export interface SimDevice {
  udid: string;
  name: string;
  /** "Booted" | "Shutdown" | "Booting" | "Shutting Down" */
  state: string;
  /** e.g. "iOS 27.0" */
  runtime: string;
  /** e.g. "iPhone 18 Pro" */
  deviceType: string;
  /** One of coool's own devices (named "coool …"). */
  coool: boolean;
}
export interface SimList {
  available: boolean;
  reason?: string;
  devices: SimDevice[];
}
export type SimInput =
  | { kind: "touch"; phase: "down" | "move" | "up"; x: number; y: number }
  | { kind: "button"; name: "home" | "lock" | "siri" | "volumeUp" | "volumeDown" }
  | { kind: "key"; name: string; modifiers?: ("shift" | "control" | "option" | "command")[] }
  | { kind: "text"; text: string };
export interface SimActivity {
  udid: string;
  /** The coool chat whose agent acted (null: none / the user). */
  chat: number | null;
  source: "agent" | "user";
  /** `end`: the agent's run is over (the "Agent is driving" mark goes off now). */
  kind: "tap" | "swipe" | "type" | "press" | "app" | "observe" | "device" | "end";
  /** Points, like `simInput`'s touches; a swipe goes from (x, y) to (x2, y2). */
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  label?: string;
}

/** One step of a device pilot run (device/pilot/mod.rs `Step`). */
export interface PilotStep {
  n: number;
  /** `memory` (muscle memory), `haiku` (Claude Haiku) or another decider. */
  decider: string;
  action: string;
  verb: string;
  perceive_ms: number;
  decide_ms: number;
  act_ms: number;
  settle_ms: number;
  note?: string;
}
/** A pilot run's state (device/pilot/mod.rs `Outcome`): `status` is final once `end` is set. */
export interface PilotOutcome {
  status: "done" | "stuck" | "surprised" | "out_of_budget";
  verified: boolean;
  reason: string;
  goal: string;
  target: "iphone" | "browser";
  steps: PilotStep[];
  wall_ms: number;
  start_ms: number;
  deciders: Record<string, number>;
  decide_ms: number;
  haiku: string;
  haiku_usd: number;
  checks: [string, boolean][];
}
/** The device pilot's decision log (Settings: "Save pilot decisions for training"). */
export interface PilotLogStatus {
  enabled: boolean;
  /** Its folder (muscle memory and decision logs); null without a data folder. */
  dir: string | null;
  bytes: number;
  files: number;
}
export interface PilotProgress {
  chat: number;
  run: number;
  /** Epoch ms the run started. */
  started: number;
  end: boolean;
  outcome: PilotOutcome;
}

export interface BrowserBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}
export interface BrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  can_back: boolean;
  can_forward: boolean;
}

export interface BrowserAgentTab {
  tab: number;
  kind: "web" | "start";
  /** Its webview, once there is one. */
  id: string | null;
  url: string;
  title: string;
}
export type BrowserAgentRequest =
  | { chat: number; op: "open" | "new"; url: string }
  | { chat: number; op: "ensure" | "switch" | "close"; tab: number };
export interface BrowserActivity {
  chat: number;
  /** The tab it acted on (null: one it is opening). */
  tab: number | null;
  kind: string;
  label?: string | null;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function tauriBackend(): Promise<Backend> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // Tauri's listen() is async; hand back a sync unlisten that also works if
  // called before registration finished.
  const sub = <T>(name: string, cb: (p: T) => void): Unlisten => {
    let off: (() => void) | null = null;
    let dead = false;
    listen<T>(name, (e) => cb(e.payload)).then((u) => (dead ? u() : (off = u)));
    return () => {
      dead = true;
      off?.();
    };
  };

  // Commands added by CHAT_SPEC may not exist in the running backend yet:
  // Tauri rejects those with "Command <name> not found". Turn that into a
  // typed NotAvailable so the UI can fall back instead of crashing.
  const soft = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      const msg = String(e);
      if (/not found|unknown command|not allowed|isn't registered|not registered/i.test(msg) && msg.includes(cmd)) throw new NotAvailable(cmd);
      throw e instanceof Error ? e : new Error(msg);
    }
  };

  // ---- sessions: one full payload, then deltas (see SessionsMerge) ----
  const merge = new SessionsMerge();
  const sessionCbs = new Set<(s: Snapshot) => void>();
  let resyncing = false;
  const deliver = (snap: Snapshot, trace?: Trace, kind?: string) => {
    const t0 = performance.now();
    for (const cb of sessionCbs) cb(snap);
    if (!trace) return;
    const recv = Date.now();
    const apply = performance.now() - t0;
    // Roughly when the result is on screen: after the next frame.
    requestAnimationFrame(() =>
      setTimeout(() => {
        const line = `seq=${trace.seq} at=${trace.at} recv=${recv - Math.round(apply)} kind=${kind} lag_ms=${recv - Math.round(apply) - trace.at} apply_ms=${apply.toFixed(2)} paint_ms=${(performance.now() - t0).toFixed(2)}`;
        invoke("trace_sessions", { line }).catch(() => {});
      }, 0),
    );
  };
  const resync = () => {
    if (resyncing) return;
    resyncing = true;
    invoke<FullWire>("list_sessions")
      .then((w) => {
        const snap = merge.full(w);
        if (snap) deliver(snap);
      })
      .catch(() => {})
      .finally(() => (resyncing = false));
  };
  let sessionsSubs: Unlisten[] = [];
  const onSessions = (cb: (s: Snapshot) => void): Unlisten => {
    sessionCbs.add(cb);
    if (sessionCbs.size === 1) {
      sessionsSubs = [
        sub<FullWire>("sessions", (w) => {
          const snap = merge.full(w);
          if (snap) deliver(snap, w.trace, "full");
        }),
        sub<DeltaWire>("sessions-delta", (w) => {
          const r = merge.delta(w);
          if (r === "gap") resync();
          else if (r !== "stale") deliver(r, w.trace, "delta");
        }),
      ];
    }
    return () => {
      sessionCbs.delete(cb);
      if (sessionCbs.size === 0) {
        sessionsSubs.forEach((u) => u());
        sessionsSubs = [];
      }
    };
  };

  return {
    kind: "tauri",
    startChat: (o) =>
      soft("start_chat", {
        opts: { provider: o.provider, cwd: o.cwd, resume: o.resume ?? null, model: o.model ?? null, permission_mode: o.permission_mode ?? null },
      }),
    chatSend: (id, text) => soft("chat_send", { id, text }),
    chatInterrupt: (id) => soft("chat_interrupt", { id }),
    chatSteer: (id, text, now) => soft("chat_steer", { id, text, now }),
    chatSteerCancel: (id, noteId) => soft("chat_steer_cancel", { id, noteId }),
    chatSetModel: (id, model) => soft("chat_set_model", { id, model }),
    chatSetPermissionMode: (id, mode) => soft("chat_set_permission_mode", { id, mode }),
    chatRespondPermission: (id, requestId, allow, always, remember) => soft("chat_respond_permission", { id, requestId, allow, always, remember: remember ?? null }),
    chatRespondQuestion: (id, requestId, answers) => soft("chat_respond_question", { id, requestId, answers }),
    chatStop: (id) => soft("chat_stop", { id }),
    chatReplay: (id) => soft("chat_replay", { id }),
    openInTerminal: (id) => soft("open_in_terminal", { id }),
    onChatEvent: (cb) => sub<ChatBatch>("chat-event", cb),
    insightsStatus: async () => {
      try {
        return { ...(await soft<InsightsStatus>("insights_status")), available: true };
      } catch (e) {
        if (isNotAvailable(e)) return { enabled: false, has_key: false, available: false };
        throw e;
      }
    },
    insightsSetKey: (key) => soft("insights_set_key", { key }),
    insightsClearKey: () => soft("insights_clear_key"),
    insightsSetEnabled: (enabled) => soft("insights_set_enabled", { enabled }),
    setShowAutomation: (enabled) => soft("set_show_automation", { enabled }),
    pilotLogStatus: () => soft("pilot_log_status"),
    pilotLogSetEnabled: (enabled) => soft("pilot_log_set_enabled", { enabled }),
    pilotLogReveal: () => soft("pilot_log_reveal"),
    pilotLogDelete: () => soft("pilot_log_delete"),
    prefsGet: () => soft("prefs_get"),
    prefsSet: (prefs) => soft("prefs_set", { prefs }),
    powerStatus: () => soft("power_status"),
    notifyPermission: () => soft("notify_permission"),
    notifyRequest: () => soft("notify_request"),
    notifyTest: () => soft("notify_test"),
    loginStatus: () => soft("login_status"),
    loginSet: (enabled) => soft("login_set", { enabled }),
    appsInstalled: () => soft("apps_installed"),
    openPath: (path) => soft("open_path", { path }),
    openSystemSettings: (pane) => soft("open_system_settings", { pane }),
    cliStatus: () => soft("cli_status"),
    connections: (project) => soft("connections", { project }),
    openConfigFile: (path, project) => soft("open_config_file", { path, project }),
    worktreesList: (project) => soft("worktrees_list", { project }),
    worktreeRemove: (project, path) => soft("worktree_remove", { project, path }),
    storageStatus: () => soft("storage_status"),
    storageClear: (id) => soft("storage_clear", { id }),
    simErase: (udid) => soft("sim_erase", { udid }),
    listSessions: async () => merge.full(await invoke<FullWire>("list_sessions")) ?? merge.snapshot(),
    spawnSession: (req) => invoke("spawn_session", { req }),
    resumeSession: (req) => invoke("resume_session", { req }),
    ptyWrite: (id, data) => invoke("pty_write", { id, data }),
    ptyResize: (id, rows, cols) => invoke("pty_resize", { id, rows, cols }),
    ptyReplay: async (id) => {
      const r = await invoke<{ data: string; offset: number }>("pty_replay", { id });
      return { bytes: b64ToBytes(r.data), offset: r.offset };
    },
    sendPrompt: (id, text) => invoke("send_prompt", { id, text }),
    stopSession: ({ managed, pid }) => invoke("stop_session", { managed: managed ?? null, pid: pid ?? null }),
    stopShell: (pid) => soft("stop_shell", { pid }),
    shellsFocus: (ids) => soft<void>("shells_focus", { ids }).catch(() => {}),
    pickFolder: () => invoke("pick_folder"),
    environment: () => invoke("environment"),
    gitTrail: (path) => invoke("git_trail", { path }),
    quit: () => invoke("quit_app"),
    usageRefresh: (provider) => invoke("usage_refresh", { provider }),
    usageResetCodex: (idempotencyKey) => invoke("usage_reset_codex", { idempotencyKey }),
    onSessions,
    onPtyOutput: (cb) =>
      sub<{ id: number; data: string; offset: number }>("pty-output", (p) =>
        cb({ id: p.id, bytes: b64ToBytes(p.data), offset: p.offset }),
      ),
    onPtyExit: (cb) => sub<{ id: number }>("pty-exit", (p) => cb(p.id)),
    onConfirmQuit: (cb) => sub<null>("confirm-quit", () => cb()),
    motionHints: () => soft<MotionHints>("motion_hints").catch(() => null),
    onMotionHints: (cb) => sub<MotionHints>("motion-hints", cb),
    artifactStatus: (urls) => invoke("artifact_status", { urls }),
    artifactWindow: (url) => invoke("artifact_window", { url }),
    openArtifact: async (url) => {
      if (!url.startsWith("https://claude.ai/")) return;
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    nativeBrowser: true,
    browserOpen: (url, bounds) => invoke("browser_open", { url, bounds }),
    browserBounds: (id, bounds) => invoke("browser_bounds", { id, bounds }),
    browserNavigate: (id, url) => invoke("browser_navigate", { id, url }),
    browserGo: (id, action) => invoke("browser_go", { id, action }),
    browserPoll: (id) => invoke("browser_poll", { id }),
    browserClose: (id) => invoke("browser_close", { id }),
    browserOpenExternal: (id) => invoke("browser_open_external", { id }),
    onBrowserState: (cb) => sub<BrowserState>("browser-state", cb),
    onBrowserClosed: (cb) => sub<string>("browser-closed", cb),
    onBrowserNewTab: (cb) => sub<{ id: string; url: string }>("browser-new-tab", cb),
    browserAgentSync: (chat, tabs, active) => invoke("browser_agent_sync", { chat, tabs, active }),
    onBrowserAgent: (cb) => sub<BrowserAgentRequest>("browser-agent", cb),
    onBrowserActivity: (cb) => sub<BrowserActivity>("browser-activity", cb),
    onPilotProgress: (cb) => sub<PilotProgress>("pilot-progress", cb),
    simDevices: async () => {
      try {
        return await soft<SimList>("sim_devices");
      } catch (e) {
        if (isNotAvailable(e)) return { available: false, reason: "This build of coool can't show an iPhone yet.", devices: [] };
        throw e;
      }
    },
    simEnsureDevice: () => soft("sim_ensure_device"),
    simBoot: (udid) => soft("sim_boot", { udid }),
    simShutdown: (udid) => soft("sim_shutdown", { udid }),
    simAttach: (udid, onFrame) => {
      // A raw channel body arrives as an ArrayBuffer; a JSON-encoded one as an array of bytes.
      const frames = new Channel<ArrayBuffer | number[]>((m) => onFrame(m instanceof ArrayBuffer ? m : new Uint8Array(m).buffer));
      return soft("sim_attach", { udid, frames });
    },
    simDetach: (udid, stream) => soft("sim_detach", { udid, stream }),
    simInput: (udid, input) => soft("sim_input", { udid, input }),
    simBind: (chat, udid) => soft("sim_bind", { chat, udid }),
    onSimActivity: (cb) => sub<SimActivity>("sim-activity", cb),
    onSimState: (cb) => sub<{ udid: string; state: string }>("sim-state", cb),
    macStatus: async () => {
      try {
        return await soft<MacStatus>("mac_status");
      } catch (e) {
        if (isNotAvailable(e)) return { available: false, reason: "This build of coool can't run a Mac yet.", state: "absent", installed: false, provisioned: false, w: 1280, h: 800 };
        throw e;
      }
    },
    macInstall: () => soft("mac_install"),
    macBoot: () => soft("mac_boot"),
    macShutdown: () => soft("mac_shutdown"),
    macAttach: (onFrame) => {
      const frames = new Channel<ArrayBuffer | number[]>((m) => onFrame(m instanceof ArrayBuffer ? m : new Uint8Array(m).buffer));
      return soft("mac_attach", { frames });
    },
    macDetach: (stream) => soft("mac_detach", { stream }),
    macInput: (input) => soft("mac_input", { input }),
    macBind: (chat, on) => soft("mac_bind", { chat, on }),
    onMacState: (cb) => sub<Partial<MacStatus>>("mac-state", cb),
  };
}

let backend: Backend;

export async function initBackend(): Promise<Backend> {
  if (backend) return backend;
  backend = isTauri ? await tauriBackend() : (await import("./mock")).mockBackend();
  return backend;
}

export function api(): Backend {
  return backend;
}
