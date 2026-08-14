// Internal, CRON_SECRET-guarded routes (OP-13/OP-14) -- machine-to-machine
// endpoints that Vercel Cron (or the local dev worker loop, or an operator
// with curl) hits directly. These are deliberately NOT reachable through the
// normal facility-token/JWT `authenticate()` pipeline every other route in
// this app uses: there is no signed-in user or facility membership behind a
// cron invocation, so the only question is "did the caller present the
// server's own CRON_SECRET". Getting that mixed up with the normal auth path
// would either lock cron out entirely or -- far worse -- let a caller who
// merely holds a valid *user* JWT trigger a service-role-privileged drain.
//
// Auth contract for every route registered here:
//   - env.CRON_SECRET unset            -> 503 (disabled; never "open").
//   - missing/malformed/wrong bearer   -> 401, checked BEFORE any DB work.
//   - correct bearer                   -> service-role client (see
//     buildServiceClient below), never the caller's token (there isn't one).
//
// Registered on the end-user router (`/api/v1` prefix) per the plan's exact
// path: POST /api/v1/internal/notifications/drain. Vercel Cron Jobs always
// fire via GET (https://vercel.com/docs/cron-jobs), and Vercel automatically
// attaches `Authorization: Bearer $CRON_SECRET` to that GET request once a
// project env var literally named CRON_SECRET is configured -- so the drain
// route is registered for both GET (cron) and POST (manual/local/test
// invocation) against the identical handler; vercel.json's `crons` block
// points at this same path.
import { timingSafeEqual } from "node:crypto";
import { createClient } from "../supabase-rest.mjs";
import { drainAll } from "../notifications/worker.mjs";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function extractBearerToken(request) {
  const header = request.headers?.authorization ?? request.headers?.Authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

// Constant-time secret comparison. A length mismatch short-circuits to
// `false` without calling timingSafeEqual (which throws on unequal-length
// buffers) -- that leaks only the *length* of a guess relative to the real
// secret, not any byte of its content, which is the property that matters
// for a bearer-token comparison.
function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Always a service-role client, keyed and authenticated as the service role
// itself -- deliberately never wired to a caller-supplied bearer token, since
// there isn't a caller identity here, only a shared secret. This is the
// "worker needs service role, not the caller's JWT" requirement from the
// plan: RLS must be bypassed for the drain to see across every facility.
function buildServiceClient(env) {
  return createClient({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
}

function clampLimit(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

async function handleDrain(request, response, { env }, sendJson) {
  if (!env.CRON_SECRET) {
    sendJson(response, 503, { error: "notifications drain is disabled: CRON_SECRET is not configured" });
    return;
  }

  const token = extractBearerToken(request);
  if (!token || !constantTimeEquals(token, env.CRON_SECRET)) {
    sendJson(response, 401, { error: "invalid or missing cron secret" });
    return;
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(response, 503, { error: "notifications drain is disabled: SUPABASE_SERVICE_ROLE_KEY is not configured" });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const limit = clampLimit(url.searchParams.get("limit"));

  const client = buildServiceClient(env);
  const summary = await drainAll({ client, now: new Date(), limit });
  sendJson(response, 200, summary);
}

// Registers the internal drain route(s) on `router`. `sendJson` is the same
// injected primitive scripts/server.mjs passes to every other route
// registrar; this registrar deliberately does NOT take `authenticate` --
// see the file header for why.
export function registerInternalRoutes(router, { sendJson }) {
  const handler = (request, response, ctx) => handleDrain(request, response, ctx, sendJson);
  router.register("POST", "/internal/notifications/drain", handler);
  router.register("GET", "/internal/notifications/drain", handler);
}
