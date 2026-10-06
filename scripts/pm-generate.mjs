#!/usr/bin/env node
// WO-19: one-shot local/manual entry point for the PM generation job --
// same relationship to src/lib/pm-generation.mjs's generatePmWorkOrders as
// scripts/notifications-worker.mjs has to drainAll, except this runs a
// SINGLE pass and exits (matching how the CRON_SECRET-guarded internal
// route already invokes it once per drain, src/lib/http/internal-routes.mjs)
// rather than looping -- a developer (or an operator's own cron/systemd
// timer, outside Vercel) runs `node scripts/pm-generate.mjs` to generate due
// PM work orders without wiring up Vercel Cron against localhost. Uses a
// real service-role Supabase client, no HTTP involved -- identical
// RLS-bypass posture to the notifications worker and the internal route.
import { fileURLToPath } from "node:url";
import { readServerEnv } from "../src/lib/env.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { generatePmWorkOrders } from "../src/lib/pm-generation.mjs";

export async function runOnce({ env = process.env, log = console.log } = {}) {
  const serverEnv = readServerEnv(env);
  if (!serverEnv.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the PM generation job.");
  }
  const client = createClient({ url: serverEnv.SUPABASE_URL, key: serverEnv.SUPABASE_SERVICE_ROLE_KEY });
  const now = new Date();
  const summary = await generatePmWorkOrders(client, { now, config: {} });
  log(JSON.stringify({ at: now.toISOString(), ...summary }));
  return summary;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runOnce().catch((error) => {
    console.error("pm-generate: fatal:", error);
    process.exitCode = 1;
  });
}
