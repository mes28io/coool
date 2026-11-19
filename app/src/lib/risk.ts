// The "Risky" tag on permission cards (APP_SPEC "Mission control", CHAT_SPEC "Questions and approvals"): a fixed,
// small rule set over what a tool call would do. It only ever says "risky", with the reason; it never says "safe",
// never counts down and never answers for the person. Pure: no React, no store (tested in risk.test.ts).
//
// The rules:
//   - a command that deletes recursively and forcibly (`rm -rf`, `rm -r -f`, `rm --recursive --force`)
//   - `git push --force` (also `-f`, `--force-with-lease`, a `+branch` refspec), `git reset --hard`
//   - a script piped from the network into a shell (`curl … | sh`, `wget -O- … | bash`, `sh -c "$(curl …)"`)
//   - `sudo`
//   - a deploy or publish (vercel, netlify, fly, firebase, wrangler, kubectl apply/delete, terraform apply/destroy,
//     `npm publish`, `cargo publish`, `docker push`, `git push heroku`, `gcloud … deploy`, `aws … deploy`, …)
//   - a file write (Write, Edit, MultiEdit, NotebookEdit, Codex's apply_patch) outside the chat's folder; the system
//     temp folders are not counted (agents put scratch files there all the time)

export interface Risk {
  /** Always true: there is no "safe" result, only a risk or null. */
  risky: true;
  /** Plain words for the tooltip: "Deletes files recursively". */
  reason: string;
}

const SEP = /&&|\|\||;|\n|\|(?!\|)|&(?!&)/;

/** The shell command of a tool call, if it is one (Claude's Bash, Codex's shell / exec, an `input.command`). */
export function commandOf(tool: string, input: unknown): string | null {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  const c = i?.command ?? i?.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) return (c as string[]).join(" ");
  if (!i && typeof input === "string" && /^(bash|shell|exec|exec_command|local_shell)$/i.test(tool)) return input;
  return null;
}

/** Words of one simple command, quotes stripped (good enough for flag checks; never executed). */
function words(seg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(seg); m; m = re.exec(seg)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The command words with leading `VAR=x`, `env`, `command`, `time`, `nohup`, `exec` and `sudo` (noted) taken off. */
function head(ws: string[]): { ws: string[]; sudo: boolean } {
  let k = 0;
  let sudo = false;
  while (k < ws.length) {
    const w = ws[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^(env|command|time|nohup|exec|builtin|xargs)$/.test(w)) k++;
    else if (w === "sudo" || w === "doas") {
      sudo = true;
      k++;
      while (k < ws.length && ws[k].startsWith("-")) k++;
    } else break;
  }
  return { ws: ws.slice(k), sudo };
}

const base = (w: string | undefined) => (w ?? "").split("/").pop() ?? "";

function rmRisk(ws: string[]): boolean {
  if (base(ws[0]) !== "rm") return false;
  let r = false;
  let f = false;
  for (const w of ws.slice(1)) {
    if (w === "--") break;
    if (w === "--recursive") r = true;
    else if (w === "--force") f = true;
    else if (/^-[A-Za-z]+$/.test(w)) {
      if (/[rR]/.test(w)) r = true;
      if (w.includes("f")) f = true;
    }
  }
  return r && f;
}

/** `git [-C dir] [-c k=v] sub ...`: the subcommand and what follows it. */
function gitSub(ws: string[]): string[] | null {
  if (base(ws[0]) !== "git") return null;
  let k = 1;
  while (k < ws.length && ws[k].startsWith("-")) k += /^(-C|-c|--git-dir|--work-tree)$/.test(ws[k]) ? 2 : 1;
  return ws.slice(k);
}

const DEPLOY: [RegExp, string][] = [
  [/^vercel( |$)(?!.*\b(dev|login|logout|whoami|env pull|link|ls|list|inspect|logs)\b)/, "vercel"],
  [/^netlify (deploy|sites:create)\b/, "netlify deploy"],
  [/^(fly|flyctl) (deploy|launch)\b/, "fly deploy"],
  [/^firebase deploy\b/, "firebase deploy"],
  [/^(wrangler|npx wrangler) (deploy|publish)\b/, "wrangler deploy"],
  [/^(kubectl|helm) (apply|delete|replace|rollout|install|upgrade|uninstall)\b/, "a cluster change"],
  [/^terraform (apply|destroy)\b/, "terraform"],
  [/^pulumi (up|destroy)\b/, "pulumi"],
  [/^(npm|pnpm|yarn|bun) publish\b/, "a package publish"],
  [/^cargo publish\b/, "a crate publish"],
  [/^(gem push|twine upload|poetry publish|dotnet nuget push)\b/, "a package publish"],
  [/^docker (push|buildx build .*--push)\b/, "an image push"],
  [/^(gcloud|aws|az) .*\b(deploy|create-deployment|update-function-code|sync s3:)/, "a cloud deploy"],
  [/^aws s3 (sync|cp|rm) .*s3:\/\//, "a cloud upload"],
  [/^heroku (deploy|releases:rollback|apps:destroy)\b/, "heroku"],
  [/^supabase (db push|functions deploy|db reset --linked)\b/, "a database / functions deploy"],
  [/^(railway|render) (up|deploy)\b/, "a deploy"],
  [/^(eas|expo) (submit|update)\b/, "an app release"],
  [/^fastlane .*\b(release|deliver|upload_to_app_store|pilot|beta)\b/, "an app release"],
  [/^gh release create\b/, "a release"],
];

/** The risk of one shell command, or null. */
export function commandRisk(command: string): Risk | null {
  const cmd = command.trim();
  if (!cmd) return null;
  // Network script into a shell: across the pipe, so before splitting.
  if (/\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi)?sh\b/.test(cmd) || /\b(ba|z)?sh\b[^|;\n]*(\$\(|<\(|`)\s*(curl|wget)\b/.test(cmd) || /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(python3?|node|ruby|perl)\b(\s+-)?\s*$/m.test(cmd))
    return { risky: true, reason: "Runs a script straight from the network" };
  for (const seg of cmd.split(SEP)) {
    const raw = words(seg.replace(/^\s*[({]+\s*/, ""));
    if (!raw.length) continue;
    const { ws, sudo } = head(raw);
    if (sudo) return { risky: true, reason: "Runs as administrator (sudo)" };
    // `bash -lc "…"` (Codex's argv form): the inner command.
    if (/^(ba|z|da)?sh$/.test(base(ws[0])) && /^-[a-z]*c$/.test(ws[1] ?? "")) {
      const inner = commandRisk(ws.slice(2).join(" "));
      if (inner) return inner;
      continue;
    }
    if (rmRisk(ws)) return { risky: true, reason: "Deletes files recursively, without asking" };
    const g = gitSub(ws);
    if (g) {
      if (g[0] === "push" && g.slice(1).some((w) => w === "--force" || w === "-f" || w.startsWith("--force-with-lease") || w === "--mirror" || /^-[a-z]*f[a-z]*$/.test(w) || /^\+[^\s]+/.test(w))) return { risky: true, reason: "Force-pushes: can overwrite history on the remote" };
      if (g[0] === "push" && g.slice(1).some((w) => w === "--delete" || w === "-d" || /^:[^\s]+$/.test(w))) return { risky: true, reason: "Deletes a branch on the remote" };
      if (g[0] === "push" && g[1] === "heroku") return { risky: true, reason: "Deploys (heroku)" };
      if (g[0] === "reset" && g.includes("--hard")) return { risky: true, reason: "Discards uncommitted changes (git reset --hard)" };
      if (g[0] === "clean" && g.slice(1).some((w) => /^-[a-z]*f/.test(w))) return { risky: true, reason: "Deletes untracked files (git clean)" };
      continue;
    }
    const line = [base(ws[0]), ...ws.slice(1)].join(" ");
    const npx = line.replace(/^(npx|pnpm dlx|pnpx|bunx|yarn dlx)( -y| --yes)? /, "");
    for (const [re, what] of DEPLOY) if (re.test(npx)) return { risky: true, reason: `Deploys or publishes (${what})` };
  }
  return null;
}

const TEMP = /^(\/tmp|\/private\/tmp|\/private\/var\/folders|\/var\/folders)(\/|$)/;

/** `p` with `.` and `..` resolved, against `cwd` when relative. */
export function resolvePath(p: string, cwd: string): string {
  const abs = p.startsWith("/") ? p : `${cwd.replace(/\/+$/, "")}/${p}`;
  const out: string[] = [];
  for (const part of abs.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** True when `p` is `dir` or inside it. */
export function inside(p: string, dir: string): boolean {
  const d = resolvePath(dir, "/");
  return p === d || p.startsWith(d === "/" ? "/" : `${d}/`);
}

const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|create_file|str_replace_based_edit_tool)$/i;

/** The files a write tool would change, or null when it isn't one. */
export function writePaths(tool: string, input: unknown): string[] | null {
  if (!WRITE_TOOLS.test(tool) || !input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "notebook_path", "path"]) if (typeof i[k] === "string" && i[k]) out.push(i[k] as string);
  if (Array.isArray(i.files)) for (const f of i.files) if (typeof f === "string") out.push(f);
  return out;
}

/** The risk of a permission request (`tool`, `input`) in a chat whose folder is `cwd`, or null. Never "safe". */
export function riskOf(tool: string, input: unknown, cwd: string): Risk | null {
  const cmd = commandOf(tool, input);
  if (cmd !== null) {
    const r = commandRisk(cmd);
    if (r) return r;
  }
  const paths = writePaths(tool, input);
  if (paths && cwd) {
    const root = resolvePath(cwd, "/");
    const out = paths.map((p) => resolvePath(p, root)).find((p) => !inside(p, root) && !TEMP.test(p));
    if (out) return { risky: true, reason: `Writes outside this chat's folder (${out})` };
  }
  return null;
}
