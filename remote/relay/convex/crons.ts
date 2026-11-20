import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep", { minutes: 30 }, internal.sweep.run, {});

export default crons;
