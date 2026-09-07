// Internal, CRON_SECRET-guarded routes (OP-13/OP-14/OP-21, plus DR-22's
// report-distribution fan-out riding the same drain invocation) -- machine-to-
// machine endpoints that Vercel Cron (or the local dev worker loop, or an
// operator with curl) hits directly. These are deliberately NOT reachable
// through the normal facility-token/JWT `authenticate()` pipeline every
// other route in this app uses: there is no signed-in user or facility
// membership behind a cron invocation, so the only question is "did the
// caller present the server's own CRON_SECRET". Getting that mixed up with
// the normal auth path would either lock cron out entirely or -- far worse
// -- let a caller who merely holds a valid *user* JWT trigger a
// service-role-privileged drain or a facility-by-facility audit read.
//
// Auth contract for every route registered here (identical for both the
// notifications drain and the audit verify-all route below):
//   - env.CRON_SECRET unset            -> 503 (disabled; never "open").
//   - missing/malformed/wrong bearer   -> 401, checked BEFORE any DB work.
//   - correct bearer                   -> service-role client (see
//     buildServiceClient below), never the caller's token (there isn't one).
//
// Registered on the end-user router (`/api/v1` prefix) per the plan's exact
// paths: POST /api/v1/internal/notifications/drain (OP-13/14) and
// POST /api/v1/internal/audit/verify-all (OP-21). Vercel Cron Jobs always
// fire via GET (https://vercel.com/docs/cron-jobs), and Vercel automatically
// attaches `Authorization: Bearer $CRON_SECRET` to that GET request once a
// project env var literally named CRON_SECRET is configured -- so both
// routes are registered for GET (cron) and POST (manual/local/test
// invocation) against the identical handler; vercel.json's `crons` block
// points at both paths.
import { timingSafeEqual } from "node:crypto";
import { createClient, pgSelect } from "../supabase-rest.mjs";
import { drainAll } from "../notifications/worker.mjs";
import { buildAdaptersFromEnv } from "../notifications/adapters.mjs";
import { executeReportWorkflowEvents } from "../report-workflow-executor.mjs";
import { processReportSubmittedEvents } from "../report-distribution.mjs";
import { verifyDbChain } from "../audit.mjs";
import { reportError } from "../observability.mjs";
import { sweepAuthThrottle } from "./durable-rate-limit.mjs";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Column set for a facility's audit chain fetched here for re-verification --
// exactly the columns verifyDbChain/computeDbRowHash read (see audit.mjs),
// plus id/chain_seq for identification/ordering. Deliberately mirrors
// audit-routes.mjs's on-demand GET .../audit/verify (VERIFY_LIMIT/AUDIT
// column set), since this route runs the identical verification, just for
// every facility instead of one caller-chosen one.
const AUDIT_CHAIN_COLUMNS =
  "id,chain_seq,created_at,event_type,entity_table,entity_id,facility_id,organization_id,event_payload,prev_hash,row_hash";
const AUDIT_VERIFY_LIMIT = 10000;

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
  // P-4/P-5: build the real email/push delivery adapters from
  // EMAIL_PROVIDER/PUSH_PROVIDER (+ their credentials) on every drain --
  // see adapters.mjs's buildAdaptersFromEnv for the noop-by-default and
  // fail-loud-on-misconfiguration contract. A misconfigured provider throws
  // here, which this route has no try/catch of its own around -- it is
  // caught by handleRequest's outer net (scripts/server.mjs) and reported
  // as a 500, same as any other unexpected drain failure; that is
  // deliberate (a cron route silently swallowing "someone typo'd
  // EMAIL_PROVIDER" would look identical to "delivery is working").
  const { emailAdapter, pushAdapter } = buildAdaptersFromEnv(env);
  // OP-20: thread OBSERVABILITY_DSN down into the worker's own failure path
  // (src/lib/notifications/worker.mjs handleFailure / processOutboxEvent's
  // catch) so a job/outbox event that dead-letters or retries here also
  // produces a fire-and-forget error report, same as every other reporting
  // call site. Unset (dev default) flows through as `undefined`, which
  // reportError treats as a silent no-op -- identical to every other call
  // site in this codebase.
  const now = new Date();
  const summary = await drainAll({
    client,
    now,
    limit,
    config: { dsn: env.OBSERVABILITY_DSN, emailAdapter, pushAdapter }
  });

  // DR-20: the report workflow ledger's own drain pass, on the same
  // CRON_SECRET-guarded service-role client and the same cadence as the
  // notifications drain above. Never throws (see
  // report-workflow-executor.mjs's own per-event try/catch) -- a broken
  // workflow event can dead-letter itself, but can never fail this route.
  const reportWorkflow = await executeReportWorkflowEvents(client, { now, limit, adapters: { emailAdapter, pushAdapter } });

  // DR-22: report-submission fan-out runs in the SAME drain invocation,
  // right after the generic notification worker -- see
  // src/lib/notifications/worker.mjs's RESERVED_OUTBOX_EVENT_TYPES for why
  // ordering relative to drainAll above is safe (that claim already
  // excludes 'report.submitted', so there is no race to lose either way).
  // config.appUrl builds the report link in every distribution email body.
  const reportDistributionSummary = await processReportSubmittedEvents({
    client,
    now,
    limit,
    adapters: { email: emailAdapter },
    config: { dsn: env.OBSERVABILITY_DSN, appUrl: env.APP_URL }
  });

  // S-7: sweep stale auth_throttle rows (older than 1 hour) on the same
  // cadence as the drain -- the durable throttle store's equivalent of the
  // in-memory limiter's own periodic sweep (rate-limit.mjs), so a table
  // written from every sign-in/refresh attempt across every instance stays
  // bounded. Fails open (never throws -- see durable-rate-limit.mjs), so a
  // sweep failure can never turn a healthy drain into a 500.
  const authThrottleSwept = await sweepAuthThrottle(client, { now: Date.now, dsn: env.OBSERVABILITY_DSN });

  sendJson(response, 200, {
    ...summary,
    reportWorkflow,
    reportDistribution: reportDistributionSummary,
    authThrottleSwept: authThrottleSwept.deleted
  });
}

// GET /internal/audit/verify-all's chain fetch for one facility. Fetches
// ascending by chain_seq (the monotonic ordering verifyDbChain requires --
// see audit.mjs) exactly like audit-routes.mjs's on-demand
// GET .../audit/verify, just parameterized over every facility instead of
// one caller-chosen one.
async function fetchFacilityChain(client, facilityId) {
  const rows = await pgSelect(client, "audit_events", {
    filters: { facility_id: facilityId },
    select: AUDIT_CHAIN_COLUMNS,
    order: "chain_seq.asc",
    limit: AUDIT_VERIFY_LIMIT
  });
  return rows ?? [];
}

// POST/GET /internal/audit/verify-all (OP-21) -- same CRON_SECRET auth
// contract as handleDrain above (503 unset, 401 wrong/missing secret, always
// a service-role client, never the normal authenticate() pipeline). Iterates
// every facility's audit hash chain via the existing verifyDbChain
// (src/lib/audit.mjs, the same function the on-demand
// GET .../audit/verify route in audit-routes.mjs uses) and reports any
// broken chain through OP-20's fire-and-forget reportError, so a tampered
// chain is both visible in this response AND lands wherever
// OBSERVABILITY_DSN points -- the "protects the compliance story" acceptance
// criterion from the plan.
async function handleVerifyAll(request, response, { env }, sendJson) {
  if (!env.CRON_SECRET) {
    sendJson(response, 503, { error: "audit verify-all is disabled: CRON_SECRET is not configured" });
    return;
  }

  const token = extractBearerToken(request);
  if (!token || !constantTimeEquals(token, env.CRON_SECRET)) {
    sendJson(response, 401, { error: "invalid or missing cron secret" });
    return;
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(response, 503, { error: "audit verify-all is disabled: SUPABASE_SERVICE_ROLE_KEY is not configured" });
    return;
  }

  const startTime = Date.now();
  const client = buildServiceClient(env);
  const facilities = await pgSelect(client, "facilities", { select: "id" });
  const broken = [];

  for (const facility of facilities ?? []) {
    const rows = await fetchFacilityChain(client, facility.id);
    const { valid, brokenAt } = verifyDbChain(rows);
    if (valid) continue;

    broken.push({ facilityId: facility.id, brokenAt, checked: rows.length });
    // Fire-and-forget (see src/lib/observability.mjs) -- never awaited, a
    // failing/slow reporter can never delay or fail this cron response.
    reportError(new Error(`audit hash chain broken for facility ${facility.id} at row index ${brokenAt}`), {
      dsn: env.OBSERVABILITY_DSN,
      route: "internal.audit.verify-all",
      status: "broken_chain",
      requestId: facility.id,
      userId: null
    });
  }

  sendJson(response, 200, {
    facilitiesChecked: (facilities ?? []).length,
    broken,
    durationMs: Date.now() - startTime
  });
}

// Registers the internal drain + audit-verify routes on `router`. `sendJson`
// is the same injected primitive scripts/server.mjs passes to every other
// route registrar; this registrar deliberately does NOT take `authenticate`
// -- see the file header for why. Both routes are registered for GET and
// POST for the identical reason documented on the drain registration below:
// Vercel Cron always fires via GET, while manual/local/test invocation uses
// POST.
export function registerInternalRoutes(router, { sendJson }) {
  const drainHandler = (request, response, ctx) => handleDrain(request, response, ctx, sendJson);
  router.register("POST", "/internal/notifications/drain", drainHandler);
  router.register("GET", "/internal/notifications/drain", drainHandler);

  const verifyAllHandler = (request, response, ctx) => handleVerifyAll(request, response, ctx, sendJson);
  router.register("POST", "/internal/audit/verify-all", verifyAllHandler);
  router.register("GET", "/internal/audit/verify-all", verifyAllHandler);
}
