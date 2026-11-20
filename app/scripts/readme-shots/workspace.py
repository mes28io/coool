#!/usr/bin/env python3
"""The invented workspace behind the README screenshots (app/scripts/readme-shots/run.sh runs it).

    python3 -I app/scripts/readme-shots/workspace.py build --root /tmp/coool-shots
    python3 -I app/scripts/readme-shots/workspace.py live  --root /tmp/coool-shots   # until SIGTERM

`build` makes, under <root> (which must not exist yet):
  home/code/<project>          six invented projects (atlas-api, pixelforge, notes-ios, project-3d, relay-docs,
                               invoices), each a small real git repository with dated commits, a merged branch,
                               a branch pushed to a local bare "origin" (<root>/remotes) and a few uncommitted edits
  home/.claude/projects/...    Claude Code transcripts for invented sessions in those projects, in the CLI's own
                               format, timed relative to now (some subagent transcripts too)
  home/.codex/sessions/...     Codex rollouts, and home/.codex/session_index.jsonl with their thread names
  home/.zshrc                  puts <root>/bin first on PATH, where run.sh installs the stand-in `claude`
                               (standin-claude.py) and a `codex` that does nothing
  live.json                    the sessions that should look live (working, waiting for the person, idle)

`live` makes those sessions live the way coool sees a running CLI: for each one it starts a `sleep` whose pid stands
in for the CLI's, writes the registry entry (`home/.claude/sessions/<pid>.json`, status busy / idle / waiting), and
keeps the working ones writing a step every few seconds. On SIGTERM it stops its sleeps and removes its entries.

Nothing here reads the real ~/.claude or ~/.codex; every name, path and text is made up. No network.
"""

import argparse
import json
import os
import random
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

RND = random.Random(11)
VERSION = "2.9.0"

# ------------------------------------------------------------------------------------------------ the projects

FILES = {
    "atlas-api": {
        "Cargo.toml": '[package]\nname = "atlas-api"\nversion = "0.4.0"\nedition = "2024"\n\n[dependencies]\naxum = "0.8"\ntokio = { version = "1", features = ["full"] }\ntower = "0.5"\nserde = { version = "1", features = ["derive"] }\n',
        "src/main.rs": 'mod config;\nmod error;\nmod middleware;\nmod routes;\n\n#[tokio::main]\nasync fn main() {\n    let cfg = config::load();\n    routes::serve(cfg).await;\n}\n',
        "src/config.rs": 'pub struct Config {\n    pub port: u16,\n    pub search_budget: u32,\n}\n\npub fn load() -> Config {\n    Config { port: 8080, search_budget: 60 }\n}\n',
        "src/error.rs": 'pub enum ApiError {\n    NotFound,\n    BadRequest(String),\n}\n',
        "src/routes/mod.rs": 'pub mod search;\n\npub async fn serve(_cfg: crate::config::Config) {}\n',
        "src/routes/search.rs": 'pub async fn search(q: String) -> Vec<String> {\n    vec![q]\n}\n',
        "src/middleware/mod.rs": 'pub mod auth;\n',
        "src/middleware/auth.rs": 'pub fn check(token: &str) -> bool {\n    !token.is_empty()\n}\n',
        "tests/search.rs": '#[test]\nfn finds_by_prefix() {}\n',
    },
    "pixelforge": {
        "Cargo.toml": '[package]\nname = "pixelforge"\nversion = "0.9.2"\nedition = "2024"\n\n[dependencies]\nwgpu = "25"\n',
        "src/main.rs": 'mod pipeline;\nmod bloom;\n\nfn main() {\n    pipeline::run();\n}\n',
        "src/pipeline.rs": 'pub fn run() {}\n',
        "src/bloom.rs": 'pub const THRESHOLD: f32 = 1.0;\n',
        "shaders/bloom.wgsl": '@fragment\nfn fs_main() -> @location(0) vec4<f32> {\n    return vec4<f32>(1.0);\n}\n',
        "shaders/tonemap.wgsl": '// ACES fit\n',
    },
    "notes-ios": {
        "Package.swift": '// swift-tools-version:6.0\nimport PackageDescription\n',
        "Notes/NoteStore.swift": 'final class NoteStore {\n    var notes: [Note] = []\n}\n',
        "Notes/EditorView.swift": 'import SwiftUI\n\nstruct EditorView: View {\n    var body: some View { TextEditor(text: .constant("")) }\n}\n',
        "Notes/Sync/CloudSync.swift": 'final class CloudSync {}\n',
        "NotesTests/MergeTests.swift": 'import XCTest\n',
    },
    "project-3d": {
        "scene/README.md": '# Gallery scene\n\nBlender 4 scene and the add-on that bakes its probes.\n',
        "addon/__init__.py": 'bl_info = {"name": "Probe Baker", "version": (0, 3, 0)}\n',
        "addon/bake.py": 'def bake_all(scene):\n    pass\n',
        "scripts/turntable.py": 'FRAMES = 120\n',
    },
    "relay-docs": {
        "package.json": '{\n  "name": "relay-docs",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "vite build" }\n}\n',
        "docs/index.md": '# Relay\n\nSend events between services with retries and signatures.\n',
        "docs/webhooks.md": '# Webhooks\n',
        "docs/quickstart.md": '# Quickstart\n',
    },
    "invoices": {
        "package.json": '{\n  "name": "invoices",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n',
        "src/format.ts": 'export function formatPeriod(d: Date): string {\n  const month = d.getMonth();\n  return `${d.getFullYear()}-${String(month).padStart(2, "0")}`;\n}\n',
        "src/invoice.ts": 'import { formatPeriod } from "./format";\n\nexport interface Invoice {\n  id: string;\n  issued: Date;\n  total: number;\n}\n\nexport const label = (i: Invoice) => `${i.id} · ${formatPeriod(i.issued)}`;\n',
        "src/export.ts": 'export function toCsv(rows: string[][]): string {\n  return rows.map((r) => r.join(",")).join("\\n");\n}\n',
        "tests/format.test.ts": 'import { formatPeriod } from "../src/format";\n',
    },
}

# (project, minutes ago, branch, message, {path: content} or None for a touch). A ("merge", ...) row merges a branch.
HISTORY = {
    "atlas-api": [
        ("init", 2900, "main", "Initial API skeleton", None),
        ("c", 600, "main", "Return JSON errors from every route", {"src/error.rs": 'pub enum ApiError {\n    NotFound,\n    BadRequest(String),\n    Unauthorized,\n}\n'}),
        ("c", 300, "main", "Add /v2/search behind a feature flag", {"src/routes/search.rs": 'pub async fn search(q: String) -> Vec<String> {\n    // v2: ranked\n    vec![q]\n}\n'}),
        ("branch", 0, "tower-auth", None, None),
        ("c", 190, "tower-auth", "Port auth middleware to tower", {"src/middleware/auth.rs": 'use tower::Layer;\n\npub fn check(token: &str) -> bool {\n    !token.is_empty()\n}\n'}),
        ("c", 186, "tower-auth", "Remove the old auth guard", {"src/main.rs": 'mod config;\nmod error;\nmod middleware;\nmod routes;\n\n#[tokio::main]\nasync fn main() {\n    let cfg = config::load();\n    routes::serve(cfg).await;\n}\n// auth runs as a tower layer\n'}),
        ("merge", 180, "main", "tower-auth", None),
        ("c", 62, "main", "Fix rounding in the search score", {"src/routes/search.rs": 'pub async fn search(q: String) -> Vec<String> {\n    // v2: ranked, scores rounded half-even\n    vec![q]\n}\n'}),
        ("push", 0, "main", None, None),
        ("branch", 0, "rate-limit", None, None),
        ("c", 52, "rate-limit", "Token bucket keyed by API key", {"src/middleware/rate_limit.rs": 'pub struct Bucket {\n    pub tokens: u32,\n}\n'}),
        ("c", 47, "rate-limit", "Wire the limiter into /v2 routes", {"src/routes/mod.rs": 'pub mod search;\n\npub async fn serve(_cfg: crate::config::Config) {\n    // limiter on /v2\n}\n'}),
        ("push", 0, "rate-limit", None, None),
        ("c", 26, "rate-limit", "Read limiter budgets from config", {"src/config.rs": 'pub struct Config {\n    pub port: u16,\n    pub search_budget: u32,\n    pub burst: u32,\n}\n\npub fn load() -> Config {\n    Config { port: 8080, search_budget: 60, burst: 10 }\n}\n'}),
        ("dirty", 0, "rate-limit", None, {"src/middleware/rate_limit.rs": 'pub struct Bucket {\n    pub tokens: u32,\n    pub refill_per_sec: u32,\n}\n', "src/routes/search.rs": 'pub async fn search(q: String) -> Vec<String> {\n    // v2: ranked, scores rounded half-even; 429 when over budget\n    vec![q]\n}\n'}),
    ],
    "pixelforge": [
        ("init", 4300, "main", "First triangle", None),
        ("c", 900, "main", "Bloom pass with a two-step blur", {"src/bloom.rs": 'pub const THRESHOLD: f32 = 1.0;\npub const STEPS: u32 = 2;\n'}),
        ("c", 400, "main", "Tonemap with the ACES fit", {"shaders/tonemap.wgsl": '// ACES fit\nfn aces(x: vec3<f32>) -> vec3<f32> { return x; }\n'}),
        ("push", 0, "main", None, None),
        ("branch", 0, "wgpu-port", None, None),
        ("c", 95, "wgpu-port", "Move the pipeline setup to wgpu 25", {"src/pipeline.rs": 'pub fn run() {\n    // wgpu 25 device + surface\n}\n'}),
        ("c", 38, "wgpu-port", "Port the bloom shader to WGSL", {"shaders/bloom.wgsl": '@fragment\nfn fs_main() -> @location(0) vec4<f32> {\n    return vec4<f32>(0.9);\n}\n'}),
        ("dirty", 0, "wgpu-port", None, {"src/pipeline.rs": 'pub fn run() {\n    // wgpu 25 device + surface, pipeline cache\n}\n'}),
    ],
    "notes-ios": [
        ("init", 7000, "main", "Notes app skeleton", None),
        ("c", 1500, "main", "Editor with Markdown preview", {"Notes/EditorView.swift": 'import SwiftUI\n\nstruct EditorView: View {\n    @State var text = ""\n    var body: some View { TextEditor(text: $text) }\n}\n'}),
        ("branch", 0, "cloudkit-sync", None, None),
        ("c", 140, "cloudkit-sync", "CloudKit zone and record mapping", {"Notes/Sync/CloudSync.swift": 'import CloudKit\n\nfinal class CloudSync {\n    let zone = CKRecordZone(zoneName: "Notes")\n}\n'}),
        ("c", 70, "cloudkit-sync", "Three-way merge for edited notes", {"NotesTests/MergeTests.swift": 'import XCTest\n\nfinal class MergeTests: XCTestCase {}\n'}),
        ("dirty", 0, "cloudkit-sync", None, {"Notes/Sync/CloudSync.swift": 'import CloudKit\n\nfinal class CloudSync {\n    let zone = CKRecordZone(zoneName: "Notes")\n    var pending: [CKRecord] = []\n}\n'}),
    ],
    "project-3d": [
        ("init", 10000, "main", "Gallery scene and probe add-on", None),
        ("c", 2200, "main", "Bake probes per room", {"addon/bake.py": 'def bake_all(scene):\n    for room in scene.collection.children:\n        pass\n'}),
        ("c", 160, "main", "Turntable script renders 120 frames", {"scripts/turntable.py": 'FRAMES = 120\nRES = (1920, 1080)\n'}),
        ("c", 75, "main", "Add-on: bake only dirty probes", {"addon/bake.py": 'def bake_all(scene, only_dirty=True):\n    for room in scene.collection.children:\n        pass\n'}),
    ],
    "relay-docs": [
        ("init", 5000, "main", "Docs site scaffold", None),
        ("c", 900, "main", "Quickstart for the Node client", {"docs/quickstart.md": '# Quickstart\n\nInstall the client and send your first event.\n'}),
        ("c", 120, "main", "Webhooks guide: signatures and retries", {"docs/webhooks.md": '# Webhooks\n\nEvery delivery is signed. Failed deliveries retry with backoff.\n'}),
        ("push", 0, "main", None, None),
    ],
    "invoices": [
        ("init", 8000, "main", "Invoice model and period labels", None),
        ("c", 1300, "main", "CSV export", {"src/export.ts": 'export function toCsv(rows: string[][]): string {\n  return rows.map((r) => r.map(q).join(",")).join("\\n");\n}\n\nconst q = (s: string) => (/[",\\n]/.test(s) ? `"${s.replace(/"/g, \'""\')}"` : s);\n'}),
        ("push", 0, "main", None, None),
    ],
}

# ------------------------------------------------------------------------------------------------ the sessions
# A step: (tool, input, result). The paths are relative to the session's folder; they are made absolute below.

def R(p, out="", lines=60):
    return ("Read", {"file_path": p}, out or f"     1\t// {p}\n     2\t...\n({lines} lines)")

def E(p, old, new):
    return ("Edit", {"file_path": p, "old_string": old, "new_string": new}, f"The file {p} has been updated.")

def W(p, content):
    return ("Write", {"file_path": p, "content": content}, f"File created successfully at: {p}")

def B(cmd, desc, out=""):
    return ("Bash", {"command": cmd, "description": desc}, out)

def G(pat, out=""):
    return ("Grep", {"pattern": pat, "output_mode": "files_with_matches"}, out or "Found 2 files")

def T(text):
    return ("thinking", text, None)

def S(text):
    return ("text", text, None)

# Each session: project, sub-folder ("" = the project), title, provider, state, minutes since its last event,
# model, turns [(prompt, [steps], reply or None if the turn is still open)], optional extras.
# state: busy (an open step), think (busy, last event a thought), idle (process alive, turn over),
# waiting:<what> (process alive, blocked on the person), ended (no process).
SESSIONS = [
    # atlas-api
    dict(p="atlas-api", title="Add rate limiting to /v2/search", state="busy", ago=0.05, model="claude-opus-5-5", branch="rate-limit", turns=[
        ("Add rate limiting to /v2/search: a token bucket per API key, budgets from config, and a 429 with Retry-After when a key is over.",
         [T("The bucket exists from the earlier commit; it needs the budgets from config and the response shape."), R("src/middleware/rate_limit.rs"), R("src/config.rs"),
          E("src/config.rs", "    pub search_budget: u32,", "    pub search_budget: u32,\n    pub burst: u32,"),
          W("src/middleware/rate_limit.rs", "pub struct Bucket { pub tokens: u32, pub refill_per_sec: u32 }\n"),
          E("src/routes/search.rs", "vec![q]", "limiter.check(&key)?;\n    vec![q]"),
          B("cargo build -p atlas-api", "Build the API", "   Compiling atlas-api v0.4.0\n    Finished `dev` profile in 6.2s"),
          ("Bash", {"command": "cargo test -p atlas-api rate_limit -- --nocapture", "description": "Run the rate limit tests"}, None)],
         None)]),
    dict(p="atlas-api", title="Make limiter budgets follow config reloads", state="think", ago=0.01, model="claude-opus-5-5", branch="rate-limit", turns=[
        ("When config.toml changes on disk the limiter keeps the old budgets. Make it pick up reloads without a restart.",
         [G("search_budget", "src/config.rs\nsrc/middleware/rate_limit.rs"), R("src/config.rs"), E("src/config.rs", "pub fn load() -> Config {", "pub fn load() -> Config {\n    // watched: see reload()"),
          T("A watch channel from the config loader to the limiter keeps it lock-free on the hot path. I'll swap the budgets atomically when a reload arrives.")],
         None)]),
    dict(p="atlas-api", title="Return 429 with a Retry-After header", state="idle", ago=12, model="claude-sonnet-5-5", branch="rate-limit", turns=[
        ("Over-budget requests should get a 429 with a Retry-After header in seconds, plus the JSON error body we use elsewhere.",
         [R("src/error.rs"), E("src/error.rs", "    Unauthorized,", "    Unauthorized,\n    TooManyRequests { retry_after: u32 },"), R("src/routes/search.rs"),
          B("cargo test -p atlas-api errors", "Run the error tests", "running 6 tests\n......\ntest result: ok. 6 passed; 0 failed")],
         "Over-budget requests now return **429 Too Many Requests** with `Retry-After` (whole seconds, rounded up) and the usual JSON body:\n\n```json\n{ \"error\": \"too_many_requests\", \"retry_after\": 3 }\n```\n\nThe 6 error tests pass.")]),
    dict(p="atlas-api", title="Port auth middleware to tower", state="ended", ago=178, model="claude-opus-5-5", branch="tower-auth", turns=[
        ("Port the auth guard to a tower Layer so every router gets it the same way, then delete the old guard.",
         [R("src/middleware/auth.rs"), E("src/middleware/auth.rs", "pub fn check", "use tower::Layer;\n\npub fn check"), B("cargo test", "Run all tests", "test result: ok. 41 passed; 0 failed"),
          B("git commit -am 'Port auth middleware to tower'", "Commit the port", "[tower-auth 4be1c02] Port auth middleware to tower")],
         "Auth is now a tower `Layer` applied once in `routes::serve`; the old guard is gone and all 41 tests pass.")]),
    dict(p="atlas-api", title="Why is /v2/search slow on cold start?", state="ended", ago=290, model="claude-sonnet-5-5", turns=[
        ("The first /v2/search after a deploy takes 2 seconds. Find out why.",
         [G("lazy_static|OnceLock"), R("src/routes/search.rs"), B("cargo run --release -- --profile-startup", "Profile the first request", "index load: 1.84s\nfirst query: 0.11s")],
         "The index loads on the first query (1.8 s of the 2 s). Loading it at startup moves that cost before the server takes traffic.")]),
    # pixelforge
    dict(p="pixelforge", title="Port the shader pipeline to wgpu 25", state="busy", ago=0.1, model="claude-opus-5-5", branch="wgpu-port", turns=[
        ("Port the render pipeline to wgpu 25. Keep the bloom and tonemap passes working.",
         [R("src/pipeline.rs"), R("shaders/bloom.wgsl"), E("src/pipeline.rs", "pub fn run() {", "pub fn run() {\n    let cache = device.create_pipeline_cache(&desc);"),
          B("cargo build", "Build", "   Compiling pixelforge v0.9.2\nwarning: unused variable `cache`"),
          ("Bash", {"command": "cargo run --example bloom -- --frames 60", "description": "Render the bloom example"}, None)],
         None)]),
    dict(p="pixelforge", title="Clear the shader cache", state="waiting:permission to run `rm -rf target/shader-cache`", ago=3, model="claude-sonnet-5-5", branch="wgpu-port", turns=[
        ("The bloom example renders black after the port. Clear the shader cache and rebuild.",
         [B("ls target/shader-cache | head", "List the cached shaders", "bloom.spv\ntonemap.spv\nblur_h.spv"),
          ("Bash", {"command": "rm -rf target/shader-cache", "description": "Delete the stale shader cache"}, None)],
         None)]),
    dict(p="pixelforge", title="Fix the bloom pass on Metal", state="idle", ago=6, model="claude-opus-5-5", turns=[
        ("On Metal the bloom pass bleeds at the screen edges. Fix it.",
         [R("shaders/bloom.wgsl"), E("shaders/bloom.wgsl", "return vec4<f32>(0.9);", "return textureSampleLevel(src, clamp_sampler, uv, 0.0);"), B("cargo run --example bloom -- --frames 1 --out /tmp/bloom.png", "Render one frame", "wrote /tmp/bloom.png")],
         "The blur sampled with a repeating sampler, so the edges picked up pixels from the opposite side. It now uses a clamping sampler; the edges are clean on Metal and Vulkan.")]),
    dict(p="pixelforge", title="Render the turntable previews", state="ended", ago=95, model="claude-opus-5-5", agents=[("Explore", "Find the turntable settings"), ("general-purpose", "Render the turntable: props"), ("general-purpose", "Render the turntable: hero")], turns=[
        ("Render the turntable previews for the props and the hero asset, 120 frames each.",
         [("Agent", {"description": "Render the turntable: props", "prompt": "Render the props turntable.", "subagent_type": "general-purpose"}, "Rendered 120 frames to renders/props/."),
          ("Agent", {"description": "Render the turntable: hero", "prompt": "Render the hero turntable.", "subagent_type": "general-purpose"}, "Rendered 120 frames to renders/hero/.")],
         "Both turntables are rendered: `renders/props/` and `renders/hero/`, 120 frames each at 1080p.")]),
    # notes-ios
    dict(p="notes-ios", title="Sync notes over CloudKit with conflict merge", state="busy", ago=0.2, model="claude-opus-5-5", branch="cloudkit-sync", turns=[
        ("Sync notes through CloudKit. When the same note changed on two devices, merge the edits instead of keeping the newest.",
         [R("Notes/Sync/CloudSync.swift"), R("Notes/NoteStore.swift"), E("Notes/Sync/CloudSync.swift", "let zone", "var pending: [CKRecord] = []\n    let zone"),
          W("NotesTests/MergeTests.swift", "import XCTest\n"),
          ("Bash", {"command": "xcodebuild test -scheme Notes -destination 'platform=iOS Simulator,name=iPhone 17'", "description": "Run the merge tests"}, None)],
         None)]),
    dict(p="notes-ios", title="Keep the keyboard from covering the editor", state="ended", ago=240, provider="codex", model="gpt-5.6", turns=[
        ("The keyboard covers the last lines of a long note. Keep the caret visible while typing.",
         [B("rg -n 'TextEditor' Notes", "", "Notes/EditorView.swift:5"), B("sed -n 1,40p Notes/EditorView.swift", "", "import SwiftUI")],
         "The editor now scrolls the caret into view above the keyboard (safe-area inset plus a scroll anchor).")]),
    # project-3d
    dict(p="project-3d", title="Bake the lighting rig", state="waiting:permission to run `blender -b gallery.blend -P addon/bake.py`", ago=1.5, model="claude-sonnet-5-5", turns=[
        ("Rebake the lighting probes for the gallery after the new skylight.",
         [R("addon/bake.py"), E("addon/bake.py", "only_dirty=True", "only_dirty=False"),
          ("Bash", {"command": "blender -b gallery.blend -P addon/bake.py", "description": "Bake every probe in the gallery scene"}, None)],
         None)]),
    dict(p="project-3d", title="Ship the Blender add-on milestone", state="ended", ago=70, model="claude-opus-5-5", turns=[
        ("Get the Probe Baker add-on ready for 0.3: bake only dirty probes, and write the changelog.",
         [R("addon/bake.py"), E("addon/bake.py", "def bake_all(scene):", "def bake_all(scene, only_dirty=True):"), W("CHANGELOG.md", "## 0.3.0\n- Bake only dirty probes\n")],
         "0.3 is ready: dirty-only baking (about 4x faster on the gallery scene) and a changelog entry.")]),
    # relay-docs
    dict(p="relay-docs", title="Preview the docs site", state="idle", ago=9, model="claude-haiku-5-5", turns=[
        ("Start the docs site locally so I can read the new webhooks page.",
         [B("pnpm install", "Install dependencies", "Done in 2.1s"), B("pnpm dev --port 4321", "Start the dev server", "  VITE ready in 312 ms\n  Local: http://localhost:4321/")],
         "The site is running at http://localhost:4321/ and the webhooks guide is at /webhooks.")]),
    dict(p="relay-docs", title="Write the webhooks guide", state="ended", ago=118, provider="codex", model="gpt-5.6", turns=[
        ("Write a webhooks guide: how deliveries are signed, how to verify them, and the retry schedule.",
         [B("cat docs/webhooks.md", "", "# Webhooks"), B("apply_patch docs/webhooks.md", "", "Success. Updated docs/webhooks.md")],
         "docs/webhooks.md now covers signatures (HMAC-SHA256 over the raw body), verification in Node and Python, and the retry schedule (5 tries over 24 h).")]),
    # invoices
    dict(p="invoices", title="Export invoices as CSV", state="ended", ago=1290, model="claude-sonnet-5-5", turns=[
        ("Add a CSV export for the invoice list, with quoting for commas in customer names.",
         [R("src/invoice.ts"), W("src/export.ts", "export function toCsv() {}\n"), B("pnpm test", "Run the tests", "Test Files  3 passed (3)")],
         "`toCsv` exports the list with RFC 4180 quoting; tests pass.")]),
    # A Codex session still working (Codex counts as working while a turn is open and the file is fresh).
    dict(p="atlas-api", title="Migrate every endpoint to the v3 error format", state="busy", ago=0.1, provider="codex", model="gpt-5.6", turns=[
        ("Move every endpoint to the v3 error format (type, title, detail) and keep v2 clients working behind the Accept header.",
         [B("rg -n 'ApiError::' src", "", "src/routes/search.rs:12\nsrc/routes/mod.rs:30"), B("apply_patch src/error.rs", "", "Success. Updated src/error.rs"),
          ("Bash", {"command": "cargo test -p atlas-api", "description": ""}, None)],
         None)]),
]

# ------------------------------------------------------------------------------------------------ build


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"


def enc(p: Path) -> str:
    return str(p).replace("/", "-").replace(".", "-")


def git_env(home, when):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(when))
    return {"PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_AUTHOR_NAME": "Demo", "GIT_AUTHOR_EMAIL": "demo@example.com", "GIT_COMMITTER_NAME": "Demo", "GIT_COMMITTER_EMAIL": "demo@example.com",
            "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp}


def build_repos(root: Path, home: Path, now: float):
    code = home / "code"
    for name, hist in HISTORY.items():
        d = code / name
        d.mkdir(parents=True)
        remote = root / "remotes" / f"{name}.git"
        remote.parent.mkdir(parents=True, exist_ok=True)
        def git(*args, when=now):
            subprocess.run(["git", *args], cwd=d, env=git_env(home, when), check=True, capture_output=True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], env=git_env(home, now), check=True, capture_output=True)
        for kind, ago, branch, msg, files in hist:
            when = now - ago * 60
            if kind == "init":
                git("init", "-q", "-b", "main")
                git("remote", "add", "origin", str(remote))
                (d / ".gitignore").write_text(".claude/\ntarget/\nnode_modules/\n")
                for p, c in FILES[name].items():
                    (d / p).parent.mkdir(parents=True, exist_ok=True)
                    (d / p).write_text(c)
                git("add", "-A")
                git("commit", "-q", "-m", msg, when=when)
            elif kind == "branch":
                git("checkout", "-q", "-b", branch)
            elif kind == "c":
                git("checkout", "-q", branch)
                for p, c in files.items():
                    (d / p).parent.mkdir(parents=True, exist_ok=True)
                    (d / p).write_text(c)
                git("add", "-A")
                git("commit", "-q", "-m", msg, when=when)
            elif kind == "merge":
                git("checkout", "-q", branch)
                git("merge", "-q", "--no-ff", msg, "-m", f"Merge branch '{msg}'", when=when)
            elif kind == "push":
                git("push", "-q", "-u", "origin", branch)
            elif kind == "dirty":
                git("checkout", "-q", branch)
                for p, c in files.items():
                    (d / p).write_text(c)
        # Leave each repository on its working branch (the last one named).
        last = [h for h in hist if h[0] in ("c", "dirty", "branch")][-1][2]
        if subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=d, capture_output=True, text=True).stdout.strip() != last:
            git("checkout", "-q", last)


def claude_transcript(home: Path, s: dict, now: float, live: list):
    cwd = home / "code" / s["p"]
    sid = str(uuid.uuid4())
    end = now - s["ago"] * 60
    # Lay the steps out backwards from the last event so every session ends exactly `ago` minutes ago.
    turns = s["turns"]
    t = 0.0
    rows, parent, agents = [], None, []
    branch = s.get("branch", "main")

    def rec(o, sidechain=False, agent=None):
        nonlocal parent
        u = str(uuid.uuid4())
        o = {"parentUuid": parent, "isSidechain": sidechain, "userType": "external", "cwd": str(cwd), "sessionId": sid, "version": VERSION,
             "gitBranch": branch, "entrypoint": "cli", **({"agentId": agent} if agent else {}), **o, "uuid": u, "timestamp": t}
        parent = u
        rows.append(o)

    def usage():
        return {"input_tokens": RND.randint(4, 60), "cache_creation_input_tokens": RND.randint(200, 3000), "cache_read_input_tokens": RND.randint(18_000, 90_000), "output_tokens": RND.randint(40, 700)}

    tid = 0
    open_turn = False
    for ti, (prompt, steps, reply) in enumerate(turns):
        start = t
        rec({"type": "user", "message": {"role": "user", "content": prompt}, "promptId": str(uuid.uuid4())})
        for kind, inp, out in steps:
            t += RND.uniform(12, 40)
            mid = f"msg_{uuid.uuid4().hex[:24]}"
            if kind == "thinking":
                rec({"type": "assistant", "message": {"id": mid, "type": "message", "role": "assistant", "model": s["model"], "content": [{"type": "thinking", "thinking": inp, "signature": "sig"}], "stop_reason": None, "usage": usage()}})
                continue
            if kind == "text":
                rec({"type": "assistant", "message": {"id": mid, "type": "message", "role": "assistant", "model": s["model"], "content": [{"type": "text", "text": inp}], "stop_reason": None, "usage": usage()}})
                continue
            tid += 1
            tu = f"toolu_{uuid.uuid4().hex[:24]}"
            inp = dict(inp)
            # (Paths stay relative to the project: Mission control matches `~` paths only under /Users or /home.)
            rec({"type": "assistant", "message": {"id": mid, "type": "message", "role": "assistant", "model": s["model"], "content": [{"type": "tool_use", "id": tu, "name": kind, "input": inp}], "stop_reason": "tool_use", "usage": usage()}})
            if out is None:
                continue  # still running (or waiting for the person)
            t += RND.uniform(2, 10)
            rec({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tu, "content": out}]}, "toolUseResult": {"stdout": out, "stderr": "", "interrupted": False}})
            if kind == "Agent":
                agents.append((inp, out, t))
        if reply is None:
            open_turn = True
            break
        t += RND.uniform(5, 15)
        rec({"type": "assistant", "message": {"id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "model": s["model"], "content": [{"type": "text", "text": reply}], "stop_reason": "end_turn", "usage": usage()}})
        rec({"type": "system", "subtype": "turn_duration", "durationMs": int((t - start) * 1000), "isMeta": False})
        if ti + 1 < len(turns):
            t += 60
    # Shift every time so the last event is exactly `ago` minutes ago.
    off = end - t
    for r in rows:
        r["timestamp"] = iso(r["timestamp"] + off)
    for inp, out, at in agents:
        write_subagent(home, cwd, sid, s, inp, out, at + off)
    rows = [json.dumps(r, separators=(",", ":")) for r in rows]
    rows.append(json.dumps({"type": "ai-title", "aiTitle": s["title"], "sessionId": sid}))
    path = home / ".claude" / "projects" / enc(cwd) / f"{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(rows) + "\n")
    os.utime(path, (end, end))
    if s["state"] != "ended":
        live.append({"provider": "claude", "sessionId": sid, "cwd": str(cwd), "path": str(path), "state": s["state"], "model": s["model"], "open": open_turn, "branch": branch})


def write_subagent(home, cwd, sid, s, inp, out, t):
    ag = f"a{uuid.uuid4().hex[:16]}"
    d = home / ".claude" / "projects" / enc(cwd) / sid / "subagents"
    d.mkdir(parents=True, exist_ok=True)
    t0 = t - 240
    rows = []
    parent = None
    for o in [{"type": "user", "message": {"role": "user", "content": inp["prompt"]}},
              {"type": "assistant", "message": {"id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5", "content": [{"type": "tool_use", "id": "toolu_x" + ag, "name": "Bash", "input": {"command": "blender -b turntable.blend -P scripts/turntable.py", "description": "Render the frames"}}], "stop_reason": "tool_use", "usage": {"input_tokens": 10, "output_tokens": 80}}},
              {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_x" + ag, "content": "Saved 120 frames"}]}},
              {"type": "assistant", "message": {"id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5", "content": [{"type": "text", "text": out}], "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 30}}}]:
        u = str(uuid.uuid4())
        t0 += 60
        rows.append(json.dumps({"parentUuid": parent, "isSidechain": True, "userType": "external", "cwd": str(cwd), "sessionId": sid, "version": VERSION, "agentId": ag, **o, "uuid": u, "timestamp": iso(t0)}))
        parent = u
    (d / f"agent-{ag}.jsonl").write_text("\n".join(rows) + "\n")
    (d / f"agent-{ag}.meta.json").write_text(json.dumps({"agentType": inp.get("subagent_type", "general-purpose"), "description": inp["description"]}))


def codex_rollout(home: Path, s: dict, now: float, live: list):
    cwd = home / "code" / s["p"]
    cid = str(uuid.uuid4())
    end = now - s["ago"] * 60
    t = end - 240
    rows = [{"timestamp": iso(t), "type": "session_meta", "payload": {"id": cid, "cwd": str(cwd), "originator": "codex_cli_rs", "cli_version": "0.80.0", "timestamp": iso(t), "model_provider": "openai"}}]
    inp = outp = 0
    open_turn = False
    for prompt, steps, reply in s["turns"]:
        rows.append({"timestamp": iso(t), "type": "turn_context", "payload": {"model": s["model"], "cwd": str(cwd), "approval_policy": "on-request", "sandbox_policy": {"mode": "workspace-write"}}})
        rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "task_started"}})
        rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]}})
        rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "user_message", "message": prompt}})
        for j, (kind, i, out) in enumerate(steps):
            t += RND.uniform(8, 30)
            call = f"call_{uuid.uuid4().hex[:20]}"
            rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": i["command"]}), "call_id": call}})
            if out is None:
                continue
            rows.append({"timestamp": iso(t + 2), "type": "response_item", "payload": {"type": "function_call_output", "call_id": call, "output": json.dumps({"output": out, "metadata": {"exit_code": 0, "duration_seconds": 1.2}})}})
            inp += RND.randint(4000, 20000)
            outp += RND.randint(100, 900)
            rows.append({"timestamp": iso(t + 2), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": inp, "cached_input_tokens": inp // 2, "output_tokens": outp}, "last_token_usage": {"input_tokens": 3000}, "model_context_window": 272000}}})
        if reply is None:
            open_turn = True
            break
        t += 10
        rows.append({"timestamp": iso(t), "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": reply}]}})
        rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "agent_message", "message": reply}})
        rows.append({"timestamp": iso(t), "type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": reply}})
    lt = time.localtime(end)
    day = home / ".codex" / "sessions" / time.strftime("%Y/%m/%d", lt)
    day.mkdir(parents=True, exist_ok=True)
    p = day / f"rollout-{time.strftime('%Y-%m-%dT%H-%M-%S', time.localtime(end - 240))}-{cid}.jsonl"
    p.write_text("\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n")
    os.utime(p, (end, end))
    with open(home / ".codex" / "session_index.jsonl", "a") as f:
        f.write(json.dumps({"id": cid, "thread_name": s["title"], "updated_at": iso(end)}) + "\n")
    if s["state"] != "ended":
        live.append({"provider": "codex", "sessionId": cid, "cwd": str(cwd), "path": str(p), "state": s["state"], "model": s["model"], "open": open_turn})


def build(root: Path):
    if root.exists():
        sys.exit(f"{root} exists; remove it first")
    home = root / "home"
    (home / ".claude" / "sessions").mkdir(parents=True)
    (home / ".codex").mkdir(parents=True)
    (root / "bin").mkdir()
    # The login shell coool asks for PATH reads this .zshrc (HOME is this folder): the stand-in CLIs come first.
    (home / ".zshrc").write_text(f'export PATH="{root / "bin"}:$PATH"\n')
    # Claude Code's own first-run state, so nothing in the app reads it as a fresh install.
    (home / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True, "numStartups": 40}))
    now = time.time()
    build_repos(root, home, now)
    live = []
    for s in SESSIONS:
        (codex_rollout if s.get("provider") == "codex" else claude_transcript)(home, s, now, live)
    (root / "live.json").write_text(json.dumps(live, indent=1))
    print(f"{len(SESSIONS)} sessions in {len(HISTORY)} projects, {len(live)} live -> {root}")


# ------------------------------------------------------------------------------------------------ live

LIVE_STEPS = {
    "rate": [("Bash", {"command": "cargo test -p atlas-api rate_limit -- --nocapture", "description": "Run the rate limit tests"}, "running 9 tests\ntest result: ok. 9 passed"),
             ("Read", {"file_path": "src/routes/search.rs"}, "     1\tpub async fn search"),
             ("Bash", {"command": "cargo clippy -p atlas-api -- -D warnings", "description": "Lint"}, "    Finished")],
    "default": [("Read", {"file_path": "README.md"}, "..."), ("Bash", {"command": "git diff --stat", "description": "Show the diff"}, " 3 files changed")],
}


def live(root: Path):
    home = root / "home"
    reg = home / ".claude" / "sessions"
    entries = json.loads((root / "live.json").read_text())
    sleeps, regs = [], []
    stop = False

    def on_term(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    print(os.getpid(), flush=True)
    try:
        for e in entries:
            if e["provider"] != "claude":
                continue
            s = subprocess.Popen(["sleep", "3600"])
            sleeps.append(s)
            now = int(time.time() * 1000)
            st = e["state"]
            status, waiting = ("busy", None) if st in ("busy", "think") else ("idle", None) if st == "idle" else ("waiting", st.split(":", 1)[1])
            r = reg / f"{s.pid}.json"
            r.write_text(json.dumps({"pid": s.pid, "sessionId": e["sessionId"], "cwd": e["cwd"], "startedAt": now, "kind": "interactive", "entrypoint": "cli",
                                     "status": status, **({"waitingFor": waiting} if waiting else {}), "name": "", "nameSource": "derived", "updatedAt": now}))
            regs.append(r)
        i = 0
        while not stop:
            # Working sessions keep going: a finished step and the next one every few seconds (Claude), a fresh
            # file time for Codex (its turn is open, so it counts as working while the file is recent).
            for e in entries:
                if e["state"] not in ("busy", "think"):
                    continue
                p = Path(e["path"])
                if e["provider"] == "codex":
                    os.utime(p, None)
                    continue
                if i % 3:
                    continue
                lines = p.read_text().splitlines()
                body, title = lines[:-1], lines[-1]
                recs = [json.loads(l) for l in body]
                last = recs[-1]
                done = {c.get("tool_use_id") for r in recs if r.get("type") == "user" and isinstance(r["message"]["content"], list) for c in r["message"]["content"]}
                open_ids = [c["id"] for r in recs if r.get("type") == "assistant" for c in r["message"]["content"] if c.get("type") == "tool_use" and c["id"] not in done]
                t = time.time()
                base = {"isSidechain": False, "userType": "external", "cwd": e["cwd"], "sessionId": e["sessionId"], "version": VERSION, "gitBranch": e.get("branch", "main"), "entrypoint": "cli"}
                rows, parent = [], last.get("uuid")

                def add(o, at):
                    nonlocal parent
                    u = str(uuid.uuid4())
                    rows.append({**base, "parentUuid": parent, **o, "uuid": u, "timestamp": iso(at)})
                    parent = u

                msg = lambda content: {"id": f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant", "model": e["model"], "content": content, "stop_reason": None, "usage": {"input_tokens": 8, "cache_read_input_tokens": 40000 + i * 300, "output_tokens": 120}}
                if e["state"] == "think":
                    add({"type": "assistant", "message": msg([{"type": "thinking", "thinking": "Checking how the reload path reaches the limiter.", "signature": "sig"}])}, t)
                else:
                    for oid in open_ids:
                        add({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": oid, "content": "ok"}]}}, t - 0.5)
                    steps = LIVE_STEPS["rate" if "atlas" in e["cwd"] else "default"]
                    kind, inp, _ = steps[(i // 3) % len(steps)]
                    inp = dict(inp)
                    add({"type": "assistant", "message": msg([{"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:24]}", "name": kind, "input": inp}])}, t)
                p.write_text("\n".join(body + [json.dumps(r, separators=(",", ":")) for r in rows] + [title]) + "\n")
            i += 1
            time.sleep(2)
    finally:
        for r in regs:
            r.unlink(missing_ok=True)
        for s in sleeps:
            s.terminate()
            s.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "live"])
    ap.add_argument("--root", required=True)
    a = ap.parse_args()
    root = Path(a.root).resolve()
    build(root) if a.cmd == "build" else live(root)


if __name__ == "__main__":
    main()
