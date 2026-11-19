// What the Settings page reads from and sends to the backend (app/src-tauri/src/lib.rs "Settings page", prefs/,
// power.rs, notify.rs, login.rs, apps.rs). Field names are the backend's own.

export interface NotifyPrefs {
  needs_you: boolean;
  finished: boolean;
  failed: boolean;
  sound: boolean;
  only_unfocused: boolean;
  /** Different sound per kind (off: the system's notification sound). */
  custom_sounds: boolean;
  /** "none" | "coool:<name>" | "system:<name>" */
  sound_needs: string;
  sound_finished: string;
  sound_failed: string;
}

/** The sounds the pickers offer (notify_sounds). `bundled`: system notifications are possible in this build. */
export interface NotifySounds {
  coool: string[];
  system: string[];
  bundled: boolean;
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
  /** "Keep working with the lid closed" and its limits. Left out of a `prefs_set`, it stays as it is. */
  lid?: LidPrefs | null;
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
  /** The lid hold (SleepDisabled through its helper) keeps the Mac awake instead, so this assertion steps aside. */
  covered?: boolean;
}

// ---------- "Keep working with the lid closed" (app/src-tauri/src/lid/, lib/lid.ts) ----------

export interface LidPrefs {
  enabled: boolean;
  /** Hold with the lid closed only while on power (default on). */
  only_on_power: boolean;
  /** On battery at or below this percent, let go (10..50, default 20). */
  min_battery: number;
  /** Longest hold of one working stretch in hours; 0 = no limit (default 8). */
  max_hours: number;
  /** Minutes it keeps holding once every agent waits on the person (0..10, default 2). */
  grace_mins: number;
}

export type LidCode = "on_battery" | "low_battery" | "hot" | "max_duration" | "needs_helper" | "helper_error" | "already_disabled" | "no_lid" | "helper_let_go" | "recovered" | "waiting";

/** An automatic release. */
export interface LidStop {
  /** Epoch ms. */
  at: number;
  code: LidCode;
  /** "battery 20%", "the Mac is running hot", "“Fix the build” was waiting for your answer (Bash: npm test)". */
  detail: string;
  /** A `waiting` stop: the chat (this run's id), its session key and the request it waited on. */
  chat?: number | null;
  session?: string | null;
  request?: string | null;
}

export type LidHelper = { state: "unavailable" | "missing" | "ready" } | { state: "unreachable"; detail: string } | { state: "outdated"; detail: number };

export interface LidReading {
  on_battery: boolean | null;
  battery_pct: number | null;
  thermal: "nominal" | "fair" | "serious" | "critical" | null;
  /** null: no lid. */
  lid_closed: boolean | null;
  /** false in closed-display mode (on power with an external display). */
  lid_sleeps: boolean | null;
  /** The system's SleepDisabled switch. */
  sleep_disabled: boolean | null;
}

export interface LidStatus {
  enabled: boolean;
  helper: LidHelper;
  /** A self-test's dry-run helper: nothing on the Mac changes. */
  dry_run: boolean;
  /** Holding now, and how: SleepDisabled through the helper, or closed-display mode plus the no-idle-sleep assertion. */
  via: "helper" | "display" | null;
  /** Agents work but it isn't holding, and why. */
  blocked: LidCode | null;
  working: number;
  /** Agents waiting on the person (a permission prompt, a question). */
  waiting?: number;
  /** Holding only through the grace (every agent waits): epoch ms it ends, and the chat it waits for. */
  grace_until?: number | null;
  grace_title?: string | null;
  /** Epoch ms the hold began. */
  since: number | null;
  reading: LidReading;
  /** Automatic releases, newest first. */
  stops: LidStop[];
  /** coool left SleepDisabled on (its marker) and no helper answers: offer "Restore normal sleep…". */
  stale: boolean;
  error: string | null;
  prefs: LidPrefs;
}

export interface NotifyPermission {
  status: "authorized" | "denied" | "not_determined" | "provisional" | "asking" | "unavailable";
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
  lidStatus(): Promise<LidStatus>;
  /** The system's administrator prompt, once; installs the helper. Rejects with "cancelled" when the person says no. */
  lidInstall(): Promise<LidStatus>;
  /** The helper removes itself (the administrator prompt only when it doesn't answer). */
  lidRemove(): Promise<LidStatus>;
  /** Turns a stale SleepDisabled off (administrator prompt). */
  lidRestore(): Promise<LidStatus>;
  notifyPermission(): Promise<NotifyPermission>;
  /** The system's one-time prompt; afterwards only System Settings changes it. */
  notifyRequest(): Promise<NotifyPermission>;
  notifyTest(): Promise<void>;
  notifySounds(): Promise<NotifySounds>;
  /** Plays a sound id in the app ("coool:rise", "system:Glass"); returns what it did. */
  notifySoundPreview(id: string): Promise<string>;
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
