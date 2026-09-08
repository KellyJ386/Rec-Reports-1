#!/usr/bin/env node
// Local dev sweep loop (IN-21). Not used in production -- Vercel's
// CRON_SECRET-guarded internal route (src/lib/http/internal-routes.mjs's
// handleDrain, response key "incidentSla") plus the `crons` block in
// vercel.json is the production entry point. This script exists so a
// developer running `npm run dev` locally still sees overdue
// incident_escalations rows expire/auto-escalate without wiring up Vercel
// Cron against localhost -- same shape as scripts/notifications-worker.mjs,
// which is the identical relationship for the notification drain.
import { fileURLToPath } from "node:url";
import { readServerEnv } from "../src/lib/env.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { sweepIncidentEscalations } from "../src/lib/incident-sla-sweep.mjs";

const DEFAULT_INTERVAL_SECONDS = 60;

function intervalMs(source = process.env) {
  const raw = Number(source.SLA_SWEEP_INTERVAL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_SECONDS;
  return seconds * 1000;
}

async function sweepPass(client) {
  const now = new Date();
  const summary = await sweepIncidentEscalations(client, { now });
  console.log(JSON.stringify({ at: now.toISOString(), ...summary }));
}

// A sleep that a pending SIGINT/SIGTERM can cut short immediately, rather
// than making the process wait out the rest of the current interval before
// noticing it should stop -- identical to notifications-worker.mjs's own
// interruptibleSleep.
function interruptibleSleep(ms, onAbortRegistrar) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    onAbortRegistrar(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runLoop({ env = process.env, log = console.log, error = console.error } = {}) {
  const serverEnv = readServerEnv(env);
  if (!serverEnv.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the incident SLA sweep loop.");
  }
  const client = createClient({ url: serverEnv.SUPABASE_URL, key: serverEnv.SUPABASE_SERVICE_ROLE_KEY });
  const delay = intervalMs(env);

  let stopRequested = false;
  let abortSleep = null;
  const requestStop = () => {
    stopRequested = true;
    if (abortSleep) abortSleep();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  log(`Incident SLA sweep loop starting: sweeping every ${delay / 1000}s (Ctrl+C to stop).`);
  while (!stopRequested) {
    try {
      await sweepPass(client);
    } catch (sweepError) {
      error("incident-sla-sweep: sweep pass failed:", sweepError);
    }
    if (stopRequested) break;
    await interruptibleSleep(delay, (abort) => {
      abortSleep = abort;
    });
  }

  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
  log("Incident SLA sweep loop stopped.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runLoop().catch((error) => {
    console.error("incident-sla-sweep: fatal:", error);
    process.exitCode = 1;
  });
}
