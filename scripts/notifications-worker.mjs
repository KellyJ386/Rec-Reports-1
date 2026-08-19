#!/usr/bin/env node
// Local dev drain loop (OP-13). Not used in production -- Vercel's
// CRON_SECRET-guarded internal route (src/lib/http/internal-routes.mjs) plus
// the `crons` block in vercel.json is the production entry point. This
// script exists so a developer running `npm run dev` locally still sees
// notification_jobs and outbox_events get drained without wiring up Vercel
// Cron against localhost. It calls the exact same worker code
// (drainAll -> drainOutboxOnce + drainOnce) the internal route calls, with a
// real service-role Supabase client -- no HTTP involved.
import { fileURLToPath } from "node:url";
import { readServerEnv } from "../src/lib/env.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { drainAll } from "../src/lib/notifications/worker.mjs";

const DEFAULT_INTERVAL_SECONDS = 30;

function intervalMs(source = process.env) {
  const raw = Number(source.WORKER_INTERVAL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_SECONDS;
  return seconds * 1000;
}

async function drainPass(client) {
  const now = new Date();
  const summary = await drainAll({ client, now });
  console.log(JSON.stringify({ at: now.toISOString(), ...summary }));
}

// A sleep that a pending SIGINT/SIGTERM can cut short immediately, rather
// than making the process wait out the rest of the current interval before
// noticing it should stop -- that is the "clean SIGINT exit" requirement.
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
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the notification worker loop.");
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

  log(`Notification worker loop starting: draining every ${delay / 1000}s (Ctrl+C to stop).`);
  while (!stopRequested) {
    try {
      await drainPass(client);
    } catch (drainError) {
      error("notifications-worker: drain pass failed:", drainError);
    }
    if (stopRequested) break;
    await interruptibleSleep(delay, (abort) => {
      abortSleep = abort;
    });
  }

  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
  log("Notification worker loop stopped.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runLoop().catch((error) => {
    console.error("notifications-worker: fatal:", error);
    process.exitCode = 1;
  });
}
