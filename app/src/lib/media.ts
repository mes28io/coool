// A chat's media files as URLs the page can load (CHAT_SPEC "Media"): asked of the backend in batches (one
// `media_grant` per frame for everything that mounted in it), cached per chat. The backend decides what may be served;
// a refusal is cached for a few seconds only (a screenshot or a render may land on disk just after it is named).

import { useEffect, useState } from "react";
import { api, type MediaGrant } from "./backend";

/** Whose files: a live chat (by id) and/or a session (`provider:id`). */
export interface MediaScope {
  chat: number | null;
  session: string | null;
}

const scopeKey = (s: MediaScope) => `${s.chat ?? ""}|${s.session ?? ""}`;
const cache = new Map<string, { at: number; p: Promise<MediaGrant> }>();
const queue = new Map<string, { scope: MediaScope; paths: Map<string, (g: MediaGrant) => void> }>();
let timer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 4000;

function flush() {
  timer = null;
  const batches = [...queue.values()];
  queue.clear();
  for (const b of batches) {
    const paths = [...b.paths.keys()];
    void api()
      .mediaGrant(b.scope, paths)
      .then(
        (gs) => {
          for (const p of paths) b.paths.get(p)!(gs.find((g) => g.path === p) ?? { path: p, name: p, size: 0, error: "no answer" });
        },
        (e) => {
          for (const p of paths) b.paths.get(p)!({ path: p, name: p, size: 0, error: String(e) });
        },
      );
  }
}

/** The grant for one file of a chat (batched with the others asked in the same tick). */
export function grant(scope: MediaScope, path: string): Promise<MediaGrant> {
  if (scope.chat === null && !scope.session) return Promise.resolve({ path, name: path, size: 0, error: "no chat" });
  const k = `${scopeKey(scope)}|${path}`;
  const hit = cache.get(k);
  if (hit) return hit.p;
  const p = new Promise<MediaGrant>((resolve) => {
    let q = queue.get(scopeKey(scope));
    if (!q) queue.set(scopeKey(scope), (q = { scope, paths: new Map() }));
    q.paths.set(path, resolve);
    timer ??= setTimeout(flush, 0);
  });
  const entry = { at: Date.now(), p };
  cache.set(k, entry);
  void p.then((g) => {
    if (g.error) setTimeout(() => cache.get(k) === entry && cache.delete(k), RETRY_MS);
  });
  return p;
}

/** A file's grant once it is known (null while asking). `on`: ask at all (a tile off screen waits). */
export function useGrant(scope: MediaScope | null, path: string | undefined, on = true): MediaGrant | null {
  const [g, setG] = useState<{ for: string; g: MediaGrant } | null>(null);
  const want = scope && path && on ? `${scopeKey(scope)}|${path}` : null;
  useEffect(() => {
    if (!want || !scope || !path) return;
    let live = true;
    void grant(scope, path).then((x) => live && setG({ for: want, g: x }));
    return () => {
      live = false;
    };
  }, [want]); // eslint-disable-line react-hooks/exhaustive-deps
  return g && g.for === want ? g.g : null;
}

/** The token in a grant's URL (what reveal and copy take). */
export const tokenOf = (g: MediaGrant | null | undefined) => g?.url?.match(/\/([0-9a-f]{16,})$/)?.[1] ?? null;
