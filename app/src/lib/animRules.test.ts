// The rule for looping animations (docs/PERF.md "Loops"): every @keyframes in the app's CSS moves `transform` or
// `opacity` only, and no animation is stepped, so WebKit can hand each loop to Core Animation and nothing wakes per
// display frame. One-offs (they end by themselves) and the known exceptions are listed below with their reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const src = new URL("..", import.meta.url);
const files = ["styles.css", ...readdirSync(new URL("components/", src)).filter((f) => f.endsWith(".css")).map((f) => `components/${f}`)];
const css = files.map((f) => [f, readFileSync(new URL(f, src), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")] as const);

/** Keyframes that may move something else: one-offs, or a loop that runs only briefly and is documented. */
const ALLOWED: Record<string, string> = {
  "stream-in": "one-off fade-in of a streamed chunk (filter blur)",
  "mode-flash": "one-off colour flash of the permission chip",
  "rv-sweep": "one-off 420 ms reveal (mask-position)",
  "usage-pill-fill": "one-off 2.8 s fill of the usage pill (width)",
  "mc-fresh": "one-off glow of a new ledger row (background-color)",
  "attn-spin": "loop, but only while a request waits for the person: a conic gradient (custom property), stepped to repaint ~12/s",
};
/** Stepped timing is allowed only here (a stepped loop costs a main-thread update every display frame). */
const STEPPED: Record<string, string> = { "attn-spin": ALLOWED["attn-spin"] };

function keyframes(text: string) {
  const out: { name: string; props: Set<string> }[] = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  for (let m; (m = re.exec(text)); ) {
    let depth = 1;
    let i = re.lastIndex;
    for (; depth && i < text.length; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
    const body = text.slice(re.lastIndex, i - 1);
    const props = new Set([...body.matchAll(/([\w-]+)\s*:/g)].map((p) => p[1]));
    out.push({ name: m[1], props });
  }
  return out;
}

test("keyframes animate transform or opacity only", () => {
  for (const [file, text] of css)
    for (const k of keyframes(text)) {
      if (ALLOWED[k.name]) continue;
      const other = [...k.props].filter((p) => p !== "transform" && p !== "opacity");
      assert.deepEqual(other, [], `${file} @keyframes ${k.name} animates ${other.join(", ")}: not on the compositor (docs/PERF.md)`);
    }
});

test("no stepped animations", () => {
  for (const [file, text] of css)
    for (const m of text.matchAll(/animation(?:-timing-function)?\s*:([^;}]*)/g)) {
      if (!/steps\(/.test(m[1])) continue;
      const name = Object.keys(STEPPED).find((n) => m[1].includes(n));
      assert.ok(name, `${file}: "${m[0].trim()}" is stepped: WebKit then updates it every display frame (docs/PERF.md)`);
    }
});

test("the allow list has no stale names", () => {
  const names = new Set(css.flatMap(([, t]) => keyframes(t).map((k) => k.name)));
  for (const n of Object.keys(ALLOWED)) assert.ok(names.has(n), `ALLOWED lists ${n}, which no longer exists`);
});
