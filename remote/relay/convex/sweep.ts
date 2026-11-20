// The scheduled sweep (crons.ts): messages nobody acknowledged go after 24 hours, and old pairings, read sessions
// and rate-limit windows after they stop mattering. Each pass deletes a bounded batch and schedules itself again
// while there is more.

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const BATCH = 400;
export const MESSAGE_TTL_MS = 24 * 3_600_000;

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let more = false;
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_created", (q) => q.lt("createdAt", now - MESSAGE_TTL_MS))
      .take(BATCH);
    for (const m of msgs) await ctx.db.delete(m._id);
    more ||= msgs.length === BATCH;
    // Pairings an hour past their expiry (a used one's device row stays).
    const pairings = await ctx.db
      .query("pairings")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now - 3_600_000))
      .take(BATCH);
    for (const p of pairings) await ctx.db.delete(p._id);
    more ||= pairings.length === BATCH;
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
      .take(BATCH);
    for (const s of sessions) await ctx.db.delete(s._id);
    more ||= sessions.length === BATCH;
    // Rate-limit windows are at most an hour long.
    const limits = (await ctx.db.query("rateLimits").take(BATCH * 4)).filter((r) => r.windowStart < now - 2 * 3_600_000).slice(0, BATCH);
    for (const r of limits) await ctx.db.delete(r._id);
    if (more) await ctx.scheduler.runAfter(1_000, internal.sweep.run, {});
    return { messages: msgs.length, pairings: pairings.length, sessions: sessions.length, rateLimits: limits.length };
  },
});
