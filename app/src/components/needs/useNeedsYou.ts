// The sessions blocked on the person: what the rail's bell counts and the Needs you page lists (NeedsPage.tsx).
// Same order as the sidebar: projects most urgent first, then their sessions.

import { attention, type Attention } from "../../lib/live";
import type { Session } from "../../lib/types";
import { useProjects } from "../Sidebar";

export interface Needed {
  s: Session;
  a: Attention;
}

export function useNeedsYou(): Needed[] {
  const { projects, digest } = useProjects();
  // A chat coool drives asks through its own requests: the transcript's "waiting for you" on it is the request just
  // answered (it lingers until the next scan), so it would come back as a terminal wait. Left out.
  const driven = (x: Needed) => x.a.source === "cli" && x.s.chat != null && digest.status[x.s.chat] !== undefined && digest.status[x.s.chat] !== "ended";
  return projects.flatMap((p) => p.live.map((s) => ({ s, a: attention(s, digest) })).filter((x) => x.a.needs && !driven(x)));
}
