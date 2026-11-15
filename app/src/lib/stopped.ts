// "Stopped is not Failed": a tool call or subagent cut off by the person (Stop, an interrupt,
// a rejected tool use) is shown as stopped, in neutral ink. Only real errors are red.

/** Whether a tool result / error text says the person stopped it (Claude and Codex wordings, and coool's own "Stopped"). */
export function isStopReason(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /^stopped\b|^interrupted\b|interrupted by (the )?user|request interrupted|user (doesn't|does not) want to (proceed|take this action)|tool use was rejected|cancell?ed by (the )?user|aborted by (the )?user|turn (was )?interrupted/i.test(t.slice(0, 400));
}
