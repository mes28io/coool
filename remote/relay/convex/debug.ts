// Internal only (no client can call it; `npx convex run debug:dump` with the deployment's admin access can): every
// row the relay stores about one Mac, exactly as stored. The tests use it to check that no plaintext of a session
// ever reaches the relay.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const dump = internalQuery({
  args: { macId: v.string() },
  handler: async (ctx, a) => {
    const by = <T extends "macs" | "devices" | "pairings" | "presence">(t: T) =>
      ctx.db
        .query(t)
        .withIndex("by_mac", (q) => q.eq("macId", a.macId))
        .collect();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_mac_dir", (q) => q.eq("macId", a.macId))
      .collect();
    const sessions = (await ctx.db.query("sessions").collect()).filter((s) => s.macId === a.macId);
    return {
      macs: await by("macs"),
      devices: await by("devices"),
      pairings: await by("pairings"),
      presence: await by("presence"),
      messages,
      sessions,
    };
  },
});
