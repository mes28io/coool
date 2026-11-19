// The "Risky" tag on permission cards (APP_SPEC "Mission control", CHAT_SPEC "Questions and approvals"): a fixed,
// small rule set over what a tool call would do. It only ever says "risky", with the reason; it never says "safe",
// never counts down and never answers for the person. Pure: no React, no store (tested in risk.test.ts).
//
// It is a short, fixed list: a request without the tag is not known to be safe, it only matched no rule, and it still
// deserves a read (the card's "What this does and why", components/Explain.tsx, helps with that).
//
// The rules (on every simple command of a chain, split outside quotes, through `bash -c "…"`, `sh -c`, `eval`, `xargs`):
//   - deleting recursively and forcibly (`rm -rf` in any spelling), `rm` / `unlink` of a path outside the chat's folder
//     (home, `~`, `..`; not temp folders), `xargs rm`, `find … -delete` / `-exec rm`
//   - `git push --force` (also `-f`, `--force-with-lease`, a `+branch` refspec, `--mirror`), deleting a remote branch,
//     `git reset --hard`, `git clean -f`, `git checkout -- …` / `git checkout .`, `git restore <paths>` (not only
//     `--staged`), `git stash drop|clear`, `git branch -D`
//   - a script piped from the network into a shell (`curl … | sh`, `wget -O- … | bash`, `sh -c "$(curl …)"`)
//   - `sudo` / `doas`
//   - `chmod -R` / `chown -R` / `chgrp -R`, `dd of=`, `mkfs*`, `diskutil erase…`, `> file` overwriting a file outside the
//     chat's folder, `DROP TABLE|DATABASE|SCHEMA` / `TRUNCATE` through a database client, `dropdb`
//   - destroying: `kubectl delete`, `terraform destroy`, `docker … prune`, `gh repo delete`
//   - a deploy or publish (vercel, netlify, fly, firebase, wrangler, kubectl / helm apply, terraform apply, `npm publish`,
//     `cargo publish`, `docker push`, `git push heroku`, `gcloud … deploy`, `aws … deploy`, …)
//   - a file write (Write, Edit, MultiEdit, NotebookEdit, Codex's apply_patch) outside the chat's folder; the system
//     temp folders are not counted (agents put scratch files there all the time)

import { patchFiles } from "./patch.ts";

export interface Risk {
  /** Always true: there is no "safe" result, only a risk or null. */
  risky: true;
  /** Plain words for the tooltip: "Deletes files recursively". */
  reason: string;
}

/** The shell command of a tool call, if it is one (Claude's Bash, Codex's shell / exec, an `input.command`). */
export function commandOf(tool: string, input: unknown): string | null {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  const c = i?.command ?? i?.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) return (c as string[]).join(" ");
  if (!i && typeof input === "string" && /^(bash|shell|exec|exec_command|local_shell)$/i.test(tool)) return input;
  return null;
}

/** `cmd` split into simple commands at `&&`, `||`, `;`, `|`, `&` and newlines that are outside quotes. */
export function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    // `2>&1`, `&>file`, `>&2`, `>|file` are redirections, not separators.
    if ((c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) || (c === "|" && cmd[i - 1] === ">")) {
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      out.push(cur);
      cur = "";
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of one simple command, quotes stripped (good enough for flag checks; never executed). */
function words(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(seg); m; m = re.exec(seg)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The command words with leading `VAR=x`, `env`, `command`, `time`, `nohup`, `exec` and `sudo` (noted) taken off. */
function head(ws: string[]): { ws: string[]; sudo: boolean; xargs: boolean } {
  let k = 0;
  let sudo = false;
  let xargs = false;
  while (k < ws.length) {
    const w = ws[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^(env|command|time|nohup|exec|builtin|nice)$/.test(w)) k++;
    else if (w === "xargs") {
      // `xargs [-0] [-I {}] [-n 1] rm …`: the command it runs on its input.
      xargs = true;
      k++;
      while (k < ws.length && ws[k].startsWith("-")) k += /^-[IinLPsdE]$/.test(ws[k]) ? 2 : 1;
    } else if (w === "sudo" || w === "doas") {
      sudo = true;
      k++;
      while (k < ws.length && ws[k].startsWith("-")) k++;
    } else break;
  }
  return { ws: ws.slice(k), sudo, xargs };
}

const base = (w: string | undefined) => (w ?? "").split("/").pop() ?? "";

function rmFlags(ws: string[]): { r: boolean; f: boolean; paths: string[] } {
  let r = false;
  let f = false;
  let end = false;
  const paths: string[] = [];
  for (const w of ws.slice(1)) {
    if (end || !w.startsWith("-") || w === "-") {
      paths.push(w);
      continue;
    }
    if (w === "--") end = true;
    else if (w === "--recursive") r = true;
    else if (w === "--force") f = true;
    else if (/^-[A-Za-z]+$/.test(w)) {
      if (/[rR]/.test(w)) r = true;
      if (w.includes("f")) f = true;
    }
  }
  return { r, f, paths };
}

/** `p` as an absolute path (`~` and `$HOME` count as home, which is outside any project), or null when unknown. */
function absPath(p: string, cwd: string): string | null {
  if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(p)) return `/~home${p.replace(/^(~|\$HOME|\$\{HOME\})/, "")}`;
  if (/[$`]/.test(p)) return null;
  return resolvePath(p, cwd);
}

/** The first of `paths` outside `cwd` (not a temp folder, not /dev/null), shown as written. */
function outsidePath(paths: string[], cwd: string): string | null {
  if (!cwd) return null;
  const root = resolvePath(cwd, "/");
  for (const p of paths) {
    const a = absPath(p, root);
    if (a && !inside(a, root) && !TEMP.test(a) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(a)) return p;
  }
  return null;
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
  [/^(kubectl|helm) (apply|replace|rollout|install|upgrade|uninstall)\b/, "a cluster change"],
  [/^terraform apply\b/, "terraform apply"],
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

/** Commands that destroy things outright, by their words (after `npx` and friends are taken off). */
const DESTROY: [RegExp, string][] = [
  [/^kubectl delete\b/, "Deletes cluster resources (kubectl delete)"],
  [/^terraform destroy\b/, "Destroys infrastructure (terraform destroy)"],
  [/^docker (system|volume|image|container|network|builder) prune\b/, "Deletes Docker data (prune)"],
  [/^gh repo delete\b/, "Deletes a GitHub repository"],
  [/^(mkfs(\.\w+)?|newfs(_\w+)?)\b/, "Formats a disk"],
  [/^diskutil (erase\w*|partitionDisk|zeroDisk|secureErase)\b/, "Erases a disk (diskutil)"],
  [/^dropdb\b/, "Deletes a database (dropdb)"],
];

/** A database client, for the DROP / TRUNCATE rule. */
const DB_CLI = /\b(psql|mysql|mariadb|sqlite3?|mongosh|mongo|clickhouse(-client)?|cockroach|sqlcmd|duckdb|pgcli|mycli|snowsql|bq|supabase db|prisma db execute|wrangler d1 execute|turso db shell)\b/;
const DB_DROP = /\b(drop\s+(table|database|schema|collection)|truncate(\s+table)?\s+\w|db\.dropDatabase|\.drop\(\))/i;

/** `> file` (not `>>`, not `2>&1`): the files a segment overwrites. */
function truncated(seg: string): string[] {
  const out: string[] = [];
  const re = /(^|[^>&0-9])(?:[1]?)>\|?\s*(?!&)("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g;
  for (let m = re.exec(seg); m; m = re.exec(seg)) out.push(m[2].replace(/^["']|["']$/g, ""));
  return out;
}

/** The risk of one shell command, or null. `cwd`: the chat's folder (rules about paths outside it need it). */
export function commandRisk(command: string, cwd = ""): Risk | null {
  return commandRiskIn(command.trim(), cwd, 0);
}

function commandRiskIn(cmd: string, cwd: string, depth: number): Risk | null {
  if (!cmd || depth > 3) return null;
  // Network script into a shell: across the pipe, so before splitting.
  if (/\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi)?sh\b/.test(cmd) || /\b(ba|z)?sh\b[^|;\n]*(\$\(|<\(|`)\s*(curl|wget)\b/.test(cmd) || /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(python3?|node|ruby|perl)\b(\s+-)?\s*$/m.test(cmd))
    return { risky: true, reason: "Runs a script straight from the network" };
  if (DB_CLI.test(cmd) && DB_DROP.test(cmd)) return { risky: true, reason: "Deletes database data (DROP / TRUNCATE)" };
  for (const seg of segments(cmd)) {
    const raw = words(seg.replace(/^\s*[({]+\s*/, ""));
    if (!raw.length) continue;
    const over = outsidePath(truncated(seg), cwd);
    if (over) return { risky: true, reason: `Overwrites a file outside this chat's folder (${over})` };
    const { ws, sudo, xargs } = head(raw);
    if (sudo) return { risky: true, reason: "Runs as administrator (sudo)" };
    const cmd0 = base(ws[0]);
    // `bash -c "…"`, `sh -lc …` (Codex's argv form too), `eval "…"`: the inner command.
    if (/^(ba|z|da|k)?sh$/.test(cmd0) && /^-[a-z]*c$/.test(ws[1] ?? "")) {
      const inner = commandRiskIn(ws.slice(2).join(" "), cwd, depth + 1);
      if (inner) return inner;
      continue;
    }
    if (cmd0 === "eval") {
      const inner = commandRiskIn(ws.slice(1).join(" "), cwd, depth + 1);
      if (inner) return inner;
      continue;
    }
    if (cmd0 === "rm" || cmd0 === "unlink" || cmd0 === "rmdir") {
      const { r, f, paths } = rmFlags(ws);
      if (cmd0 === "rm" && r && f) return { risky: true, reason: "Deletes files recursively, without asking" };
      if (xargs && cmd0 === "rm") return { risky: true, reason: "Deletes the files piped into it (xargs rm)" };
      const out = outsidePath(paths, cwd);
      if (out) return { risky: true, reason: `Deletes outside this chat's folder (${out})` };
      continue;
    }
    if (cmd0 === "find" && ws.some((w, i) => w === "-delete" || ((w === "-exec" || w === "-execdir" || w === "-ok") && /^(\/bin\/)?(rm|unlink)$/.test(ws[i + 1] ?? ""))))
      return { risky: true, reason: "Deletes every file find matches" };
    if ((cmd0 === "chmod" || cmd0 === "chown" || cmd0 === "chgrp") && ws.slice(1).some((w) => /^-[A-Za-z]*R[A-Za-z]*$/.test(w) || w === "--recursive"))
      return { risky: true, reason: `Changes ${cmd0 === "chmod" ? "permissions" : "owners"} recursively (${cmd0} -R)` };
    if (cmd0 === "dd" && ws.some((w) => w.startsWith("of="))) return { risky: true, reason: "Writes raw data over a file or disk (dd of=)" };
    const g = gitSub(ws);
    if (g) {
      if (g[0] === "push" && g.slice(1).some((w) => w === "--force" || w === "-f" || w.startsWith("--force-with-lease") || w === "--mirror" || /^-[a-z]*f[a-z]*$/.test(w) || /^\+[^\s]+/.test(w))) return { risky: true, reason: "Force-pushes: can overwrite history on the remote" };
      if (g[0] === "push" && g.slice(1).some((w) => w === "--delete" || w === "-d" || /^:[^\s]+$/.test(w))) return { risky: true, reason: "Deletes a branch on the remote" };
      if (g[0] === "push" && g[1] === "heroku") return { risky: true, reason: "Deploys (heroku)" };
      if (g[0] === "reset" && g.includes("--hard")) return { risky: true, reason: "Discards uncommitted changes (git reset --hard)" };
      if (g[0] === "clean" && g.slice(1).some((w) => /^-[a-z]*f/.test(w))) return { risky: true, reason: "Deletes untracked files (git clean)" };
      if (g[0] === "checkout" && (g.includes("--") || g[1] === "." || g.includes("-f") || g.includes("--force"))) return { risky: true, reason: "Discards uncommitted changes to files (git checkout)" };
      if (g[0] === "restore" && g.length > 1 && (!g.some((w) => w === "--staged" || w === "-S") || g.some((w) => w === "--worktree" || w === "-W"))) return { risky: true, reason: "Discards uncommitted changes to files (git restore)" };
      if (g[0] === "stash" && (g[1] === "drop" || g[1] === "clear")) return { risky: true, reason: `Deletes stashed changes (git stash ${g[1]})` };
      if (g[0] === "branch" && g.some((w) => w === "-D")) return { risky: true, reason: "Deletes a branch even if it isn't merged (git branch -D)" };
      continue;
    }
    const line = [cmd0, ...ws.slice(1)].join(" ");
    const npx = line.replace(/^(npx|pnpm dlx|pnpx|bunx|yarn dlx)( -y| --yes)? /, "");
    for (const [re, why] of DESTROY) if (re.test(npx)) return { risky: true, reason: why };
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
  // Codex's patch (lib/patch.ts): each file, and where a move puts it.
  for (const f of patchFiles(input) ?? []) out.push(f.path, ...(f.movePath ? [f.movePath] : []));
  return out;
}

/** The risk of a permission request (`tool`, `input`) in a chat whose folder is `cwd`, or null. Never "safe". */
export function riskOf(tool: string, input: unknown, cwd: string): Risk | null {
  const cmd = commandOf(tool, input);
  if (cmd !== null) {
    const r = commandRisk(cmd, cwd);
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
