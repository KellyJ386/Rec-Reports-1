#!/usr/bin/env node
// TR-11: one-shot local/manual entry point for the certification expiry
// evaluator -- same relationship to src/lib/training-cert-expiry.mjs's
// scanCertificationExpiry as scripts/pm-generate.mjs has to
// generatePmWorkOrders. A developer (or an operator's own cron/systemd
// timer, outside Vercel) runs `node scripts/training-cert-expiry.mjs` to
// emit the cert.expiring / cert.expired events and notification jobs.
// Uses a real service-role Supabase client, no HTTP involved.
import { fileURLToPath } from "node:url";
import { readServerEnv } from "../src/lib/env.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { scanCertificationExpiry } from "../src/lib/training-cert-expiry.mjs";

export async function runOnce({ env = process.env, log = console.log } = {}) {
  const serverEnv = readServerEnv(env);
  if (!serverEnv.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to run the certification expiry job.");
  }
  const client = createClient({ url: serverEnv.SUPABASE_URL, key: serverEnv.SUPABASE_SERVICE_ROLE_KEY });
  const now = new Date();
  const summary = await scanCertificationExpiry(client, { now });
  log(JSON.stringify({ at: now.toISOString(), ...summary }));
  return summary;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runOnce().catch((error) => {
    console.error("training-cert-expiry: fatal:", error);
    process.exitCode = 1;
  });
}
