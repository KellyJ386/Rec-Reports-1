#!/usr/bin/env node
// TR-09: one-shot local/manual entry point for the training auto-assignment
// evaluator -- same relationship to src/lib/training-auto-assign.mjs's
// runTrainingAutoAssign as scripts/pm-generate.mjs has to generatePmWorkOrders.
// A developer (or an operator's own cron/systemd timer, outside Vercel) runs
// `node scripts/training-auto-assign.mjs` to apply the certification/role
// rules without wiring up Vercel Cron against localhost. Uses a real
// service-role Supabase client, no HTTP involved -- the same RLS-bypass
// posture as the notifications worker and the CRON_SECRET-guarded drain.
import { fileURLToPath } from "node:url";
import { readServerEnv } from "../src/lib/env.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { runTrainingAutoAssign } from "../src/lib/training-auto-assign.mjs";

export async function runOnce({ env = process.env, log = console.log, limit = 100 } = {}) {
  const serverEnv = readServerEnv(env);
  if (!serverEnv.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the training auto-assignment job.");
  }
  const client = createClient({ url: serverEnv.SUPABASE_URL, key: serverEnv.SUPABASE_SERVICE_ROLE_KEY });
  const now = new Date();
  const summary = await runTrainingAutoAssign(client, { now, limit });
  log(JSON.stringify({ at: now.toISOString(), ...summary }));
  return summary;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runOnce().catch((error) => {
    console.error("training-auto-assign: fatal:", error);
    process.exitCode = 1;
  });
}
