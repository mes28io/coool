// One interface, two implementations: the Tauri shell, or a built-in mock
// when running in a plain browser (`pnpm dev`). See docs/APP_SPEC.md.

import type { ChatEvent, ChatOptions, Environment, InsightsStatus, Provider, Snapshot } from "./types";

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

export interface Backend {
  kind: "tauri" | "mock";
  listSessions(): Promise<Snapshot>;
  spawnSession(a: { provider: Provider; cwd: string; args?: string[]; rows: number; cols: number }): Promise<number>;
  resumeSession(a: { provider: Provider; sessionId: string; cwd: string; rows: number; cols: number }): Promise<number>;
  ptyWrite(id: number, data: string): Promise<void>;
  ptyResize(id: number, rows: number, cols: number): Promise<void>;
  ptyReplay(id: number): Promise<{ bytes: Uint8Array; offset: number }>;
  sendPrompt(id: number, text: string): Promise<void>;
  stopSession(a: { managed?: number | null; pid?: number | null }): Promise<void>;
  pickFolder(): Promise<string | null>;
  environment(): Promise<Environment>;
  quit(): Promise<void>;
  onSessions(cb: (s: Snapshot) => void): Unlisten;
  onPtyOutput(cb: (c: PtyChunk) => void): Unlisten;
  onPtyExit(cb: (id: number) => void): Unlisten;
  onConfirmQuit(cb: () => void): Unlisten;
  /** Ask for a plan-usage reading now; the result arrives with a later `sessions` payload. */
  usageRefresh(provider: Provider): Promise<void>;

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
  const { invoke } = await import("@tauri-apps/api/core");
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
    listSessions: () => invoke("list_sessions"),
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
    pickFolder: () => invoke("pick_folder"),
    environment: () => invoke("environment"),
    quit: () => invoke("quit_app"),
    usageRefresh: (provider) => invoke("usage_refresh", { provider }),
    onSessions: (cb) => sub<Snapshot>("sessions", cb),
    onPtyOutput: (cb) =>
      sub<{ id: number; data: string; offset: number }>("pty-output", (p) =>
        cb({ id: p.id, bytes: b64ToBytes(p.data), offset: p.offset }),
      ),
    onPtyExit: (cb) => sub<{ id: number }>("pty-exit", (p) => cb(p.id)),
    onConfirmQuit: (cb) => sub<null>("confirm-quit", () => cb()),
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
