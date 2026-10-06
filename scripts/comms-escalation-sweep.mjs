#!/usr/bin/env node
// CM-10 local dev escalation loop. Mirrors scripts/notifications-worker.mjs
// exactly (same interval/SIGINT/SIGTERM shape) so the required-acknowledgement
// escalation sweep works standalone -- without the CRON_SECRET-guarded internal
// route -- the same way that script lets the generic notification worker run
// locally. In production, src/lib/http/internal-routes.mjs's drain route
// already calls sweepAckEscalations on every cron pass (response key
// `commsEscalation`); this script is for local/dev use only, exactly like its
// notifications-worker.mjs counterpart.
import { fileURLToPath } from "node:url";
import { readServerEnv } from "../src/lib/env.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { sweepAckEscalations } from "../src/lib/comms-escalation-sweep.mjs";

const DEFAULT_INTERVAL_SECONDS = 60;

function intervalMs(source = process.env) {
  const raw = Number(source.COMMS_ESCALATION_SWEEP_INTERVAL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_SECONDS;
  return seconds * 1000;
}

async function sweepPass(client) {
  const now = new Date();
  const summary = await sweepAckEscalations(client, { now });
  console.log(JSON.stringify({ at: now.toISOString(), ...summary }));
}

// Same interruptible-sleep shape as notifications-worker.mjs's own helper --
// a pending SIGINT/SIGTERM cuts the wait short immediately rather than
// waiting out the rest of the current interval.
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
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the comms ack escalation sweep loop.");
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

  log(`Comms ack escalation sweep loop starting: scanning every ${delay / 1000}s (Ctrl+C to stop).`);
  while (!stopRequested) {
    try {
      await sweepPass(client);
    } catch (scanError) {
      error("comms-escalation-sweep: scan pass failed:", scanError);
    }
    if (stopRequested) break;
    await interruptibleSleep(delay, (abort) => {
      abortSleep = abort;
    });
  }

  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
  log("Comms ack escalation sweep loop stopped.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runLoop().catch((error) => {
    console.error("comms-escalation-sweep: fatal:", error);
    process.exitCode = 1;
  });
}
