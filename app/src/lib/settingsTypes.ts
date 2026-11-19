// What the Settings page reads from and sends to the backend (app/src-tauri/src/lib.rs "Settings page", prefs/,
// power.rs, notify.rs, login.rs, apps.rs). Field names are the backend's own.

export interface NotifyPrefs {
  needs_you: boolean;
  finished: boolean;
  failed: boolean;
  sound: boolean;
  only_unfocused: boolean;
}

/** The General and Notifications options the backend applies (settings.json). */
export interface AppPrefs {
  confirm_quit: boolean;
  prevent_sleep: boolean;
  notify: NotifyPrefs;
  /** An `InstalledApp.id`, or "system". */
  open_with: string;
  /** What the person builds (the onboarding's "What are you building?", Settings > General). Older backends: absent. */
  building?: Building[];
}

/** The onboarding's answer: each kind suggests a device panel (components/onboarding/BuildStep.tsx). */
export type Building = "mobile" | "web" | "desktop" | "other";

export interface PowerStatus {
  enabled: boolean;
  /** The no-idle-sleep assertion is held right now. */
  held: boolean;
  working: number;
  /** macOS refused the assertion. */
  failed: boolean;
}

export interface NotifyPermission {
  status: "authorized" | "denied" | "not_determined" | "provisional" | "unavailable";
  reason?: string | null;
}

export interface LoginStatus {
  status: "enabled" | "not_registered" | "requires_approval" | "not_found" | "unavailable";
  reason?: string | null;
}

export interface InstalledApp {
  id: string;
  name: string;
  path: string;
}

export interface CliStatus {
  provider: "claude" | "codex";
  name: string;
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
  /** A shell command that fixes it. */
  fix: string | null;
  install: string;
}

export interface ConfigFile {
  path: string;
  label: string;
  exists: boolean;
}
export interface McpServer {
  name: string;
  scope: "user" | "project" | "local" | string;
  transport: "stdio" | "http" | "sse" | string;
  command: string | null;
  url: string | null;
  env_keys: string[];
  header_keys: string[];
  disabled: boolean;
  file: string;
}
export interface Hook {
  event: string;
  matcher: string | null;
  command: string;
  file: string;
}
export interface Plugin {
  name: string;
  source: string | null;
  enabled: boolean;
  version: string | null;
  file: string;
}
export interface ProviderConn {
  files: ConfigFile[];
  mcp: McpServer[];
  hooks: Hook[];
  plugins: Plugin[];
  errors: string[];
}
export interface Connections {
  claude: ProviderConn;
  codex: ProviderConn;
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  main: boolean;
  agent: boolean;
  merged: boolean;
  dirty: boolean;
  locked: boolean;
  prunable: boolean;
  bytes: number | null;
  removable: boolean;
  why_not: string | null;
}
export interface Worktrees {
  git: string | null;
  root: string | null;
  main_branch: string | null;
  list: Worktree[];
  error: string | null;
}

export interface StorageItem {
  id: string;
  label: string;
  desc: string;
  path: string | null;
  bytes: number | null;
  files: number | null;
  clearable: boolean;
  clear_label: string | null;
}
export interface SimInfo {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  device_type: string;
  bytes: number | null;
}
export interface StorageStatus {
  items: StorageItem[];
  simulator: SimInfo | null;
}

/** The Settings calls of the Backend interface (backend.ts). */
export interface SettingsBackend {
  prefsGet(): Promise<AppPrefs>;
  prefsSet(prefs: AppPrefs): Promise<void>;
  powerStatus(): Promise<PowerStatus>;
  notifyPermission(): Promise<NotifyPermission>;
  /** The system's one-time prompt; afterwards only System Settings changes it. */
  notifyRequest(): Promise<NotifyPermission>;
  notifyTest(): Promise<void>;
  loginStatus(): Promise<LoginStatus>;
  loginSet(enabled: boolean): Promise<LoginStatus>;
  appsInstalled(): Promise<InstalledApp[]>;
  /** Opens a file or folder with the app chosen in General. */
  openPath(path: string): Promise<void>;
  openSystemSettings(pane: "notifications" | "login"): Promise<void>;
  /** The first-run onboarding was finished or dismissed (kept in settings.json; components/onboarding/). */
  onboardingSeen(): Promise<boolean>;
  onboardingSetSeen(seen: boolean): Promise<void>;
  cliStatus(): Promise<CliStatus[]>;
  connections(project: string | null): Promise<Connections>;
  openConfigFile(path: string, project: string | null): Promise<void>;
  worktreesList(project: string): Promise<Worktrees>;
  /** Refused unless merged, clean and an agent worktree; never forced. */
  worktreeRemove(project: string, path: string): Promise<Worktrees>;
  storageStatus(): Promise<StorageStatus>;
  storageClear(id: string): Promise<StorageStatus>;
  /** Erases coool's own simulator (refuses any other). */
  simErase(udid: string): Promise<void>;
}
