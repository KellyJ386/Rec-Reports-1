import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readServerEnv } from "../src/lib/env.mjs";
import { createRouter } from "../src/lib/http/router.mjs";
import { createJwtVerifier, loadMemberships, loadPlatformAdmin } from "../src/lib/http/auth.mjs";
import { requireAuthOrgAdmin } from "../src/lib/http/guard.mjs";
import { validateModuleTogglePayload } from "../src/lib/http/validate.mjs";
import { registerAdminRoutes } from "../src/lib/http/admin-routes.mjs";
import { registerAuditRoutes } from "../src/lib/http/audit-routes.mjs";
import { registerWorkflowRoutes } from "../src/lib/http/workflow-routes.mjs";
import { registerFormsRoutes } from "../src/lib/http/forms-routes.mjs";
import { registerReportTemplatesRoutes } from "../src/lib/http/report-templates-routes.mjs";
import { registerNotificationRoutes } from "../src/lib/http/notification-routes.mjs";
import { registerCertPolicyRoutes } from "../src/lib/http/cert-policy-routes.mjs";
import { registerBillingRoutes } from "../src/lib/http/billing-routes.mjs";
import { registerReportRoutes } from "../src/lib/http/reports-routes.mjs";
import { registerIncidentRoutes } from "../src/lib/http/incidents-routes.mjs";
import { registerWorkOrderRoutes } from "../src/lib/http/work-orders-routes.mjs";
import { registerSchedulingRoutes } from "../src/lib/http/scheduling-routes.mjs";
import { registerCommunicationRoutes } from "../src/lib/http/communications-routes.mjs";
import { registerTrainingRoutes } from "../src/lib/http/training-routes.mjs";
import { registerAuthRoutes } from "../src/lib/http/auth-routes.mjs";
import { registerMeRoute } from "../src/lib/http/me-route.mjs";
import { registerAttachmentRoutes } from "../src/lib/http/attachments-routes.mjs";
import { registerInternalRoutes } from "../src/lib/http/internal-routes.mjs";
import { createClient, pgSelect, pgInsert } from "../src/lib/supabase-rest.mjs";
import { reportError } from "../src/lib/observability.mjs";

const root = process.argv[2] === "dist" ? "dist" : "src/public";
const port = Number(process.env.PORT ?? 3000);
const apiPrefix = "/api/admin/v1";
const userApiPrefix = "/api/v1";
const contentTypes = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript" };

const securityHeaders = Object.freeze({
  "Content-Security-Policy": "default-src 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000"
});

function loadEnv() {
  try {
    return { env: readServerEnv(), error: null };
  } catch (error) {
    return { env: null, error };
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, { ...securityHeaders, "Content-Type": "application/json" });
  response.end(body);
}

export const maxBodyBytes = 1024 * 1024;

export function readBody(request) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > maxBodyBytes) {
      request.destroy();
      reject(new Error("request body too large"));
      return;
    }
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBodyBytes) {
        request.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function extractBearerToken(request) {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function buildClient(env, authToken) {
  return createClient({
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY,
    authToken
  });
}

async function authenticate(request, env) {
  // Either signing mode is enough to verify a token: the legacy shared secret
  // (HS256) or the project's published JWKS (ES256/RS256, needs only the
  // project URL). Refuse only when neither is available.
  if (!env.SUPABASE_JWT_SECRET && !env.SUPABASE_URL) {
    return {
      error: {
        status: 503,
        body: { error: "SUPABASE_JWT_SECRET or SUPABASE_URL is not configured" }
      }
    };
  }
  const token = extractBearerToken(request);
  if (!token) return { error: { status: 401, body: { error: "missing bearer token" } } };
  const verify = createJwtVerifier({
    jwtSecret: env.SUPABASE_JWT_SECRET,
    supabaseUrl: env.SUPABASE_URL
  });
  const claims = await verify(token);
  if (!claims || !claims.sub) {
    return { error: { status: 401, body: { error: "invalid or expired token" } } };
  }
  // Record the verified subject for the request log (see logRequest). Stashing
  // it here rather than re-verifying the token in handleRequest keeps a single
  // verification per request and guarantees the log only ever attributes a
  // request to an identity this function actually accepted.
  request.authenticatedUserId = claims.sub;
  const client = buildClient(env, token);
  const memberships = await loadMemberships(client, claims.sub);
  const platformAdmin = await loadPlatformAdmin(client, claims.sub);
  return { claims, client, memberships, platformAdmin, error: null };
}

async function orgFacilityIds(client, organizationId) {
  const rows = await pgSelect(client, "facilities", {
    filters: { organization_id: organizationId },
    select: "id"
  });
  return (rows ?? []).map((row) => row.id);
}

export const router = createRouter();

router.register("GET", "/modules", async (request, response, { env }) => {
  const auth = await authenticate(request, env);
  if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
  const rows = await pgSelect(auth.client, "modules", {
    select: "id,code,name,category,default_enabled",
    order: "category.asc"
  });
  sendJson(response, 200, rows ?? []);
});

router.register("GET", "/org/:id/module-settings", async (request, response, { env, params }) => {
  const auth = await authenticate(request, env);
  if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
  const facilityIds = await orgFacilityIds(auth.client, params.id);
  const guardResult = requireAuthOrgAdmin(auth, facilityIds);
  if (!guardResult.allowed) return sendJson(response, 403, { error: guardResult.reason });
  const rows = await pgSelect(auth.client, "organization_module_settings", {
    filters: { organization_id: params.id },
    select: "id,module_id,enabled,config_jsonb,updated_at"
  });
  sendJson(response, 200, rows ?? []);
});

router.register("PUT", "/org/:id/module-settings/:moduleId", async (request, response, { env, params }) => {
  const auth = await authenticate(request, env);
  if (auth.error) return sendJson(response, auth.error.status, auth.error.body);

  let payload;
  try {
    payload = JSON.parse((await readBody(request)) || "{}");
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }

  const { valid, errors } = validateModuleTogglePayload(payload);
  if (!valid) return sendJson(response, 422, { errors });

  const facilityIds = await orgFacilityIds(auth.client, params.id);
  const guardResult = requireAuthOrgAdmin(auth, facilityIds);
  if (!guardResult.allowed) return sendJson(response, 403, { error: guardResult.reason });

  const rows = await pgInsert(
    auth.client,
    "organization_module_settings",
    [
      {
        organization_id: params.id,
        module_id: params.moduleId,
        enabled: payload.enabled,
        config_jsonb: payload.configPatch ?? {},
        updated_by: auth.claims.sub
      }
    ],
    { onConflict: "organization_id,module_id", merge: true, returning: true }
  );
  sendJson(response, 200, (rows ?? [])[0] ?? null);
});

// Phase 3 org-tree/admin routes (identity, module overrides, facilities,
// departments, facility settings). Registered with the same auth/guard pipeline
// used by the endpoints above; logic lives in the admin lib modules.
registerAdminRoutes(router, { authenticate, sendJson, readBody });

// Phase 5 Audit & Compliance routes (timeline, hash-chain verify, export).
// Same auth/guard pipeline as above; logic lives in src/lib/admin/audit-export.mjs.
registerAuditRoutes(router, { authenticate, sendJson, readBody });

// Phase 6 workflow routes (change requests, branding, generic data export).
// Same auth/guard pipeline as above; logic lives in src/lib/admin/change-requests.mjs,
// src/lib/admin/branding.mjs, and src/lib/admin/export.mjs.
registerWorkflowRoutes(router, { authenticate, sendJson, readBody });

// Phase 7 Forms & Fields (lite) routes (custom fields, versioned form
// definitions, publish/retire). Logic lives in src/lib/admin/forms.mjs.
registerFormsRoutes(router, { authenticate, sendJson, readBody });

// Daily Reports template management (DR-02..DR-04): draft/publish/archive for
// report_templates + report_template_versions. Logic lives in
// src/lib/report-templates.mjs; writes require reports.template.manage
// (publish additionally requires reports.publish), matching the 0028 RLS.
registerReportTemplatesRoutes(router, { authenticate, sendJson, readBody });

// Phase 7 Notifications routing routes (event catalog, distribution lists +
// members, routes, and the test-notification sandbox). Logic lives in
// src/lib/admin/notifications.mjs.
registerNotificationRoutes(router, { authenticate, sendJson, readBody });

// Phase 7 Certification policy routes (role requirements, policies, gaps report).
// Writes require training.manage AND the cert_policies plan entitlement (402).
// Logic lives in src/lib/admin/cert-policy.mjs + src/lib/admin/entitlements.mjs.
registerCertPolicyRoutes(router, { authenticate, sendJson, readBody });

// Phase 7 Billing & Subscription + feature-flag routes (subscription/plan,
// usage meters, feature-flag catalog + effective state, scope-gated rule
// writes). Logic lives in src/lib/admin/entitlements.mjs.
registerBillingRoutes(router, { authenticate, sendJson, readBody });

// GET /me on the admin prefix as well. The admin control center's fetch wrapper
// is pinned to /api/admin/v1, so it cannot reach the end-user copy below. This
// mounts the same handler on both prefixes; admin-routes.mjs used to carry a
// second /me of its own with a different payload shape, which meant the two
// apps disagreed about what a session looks like.
registerMeRoute(router, { authenticate, sendJson });

// --- End-user product routes (/api/v1) -------------------------------------
// The operational modules that facility staff use directly (as opposed to the
// admin control center). Same injected auth/guard pipeline as the admin router;
// each module registers on this separate router and is dispatched under the
// /api/v1 prefix. Logic lives in the already-tested domain libs under src/lib/.
export const userRouter = createRouter();

// Unauthenticated: hands the browser the public Supabase config (project URL and
// anon key) so the login page can drive the same-origin auth proxy below. The
// anon key is public by design.
userRouter.register("GET", "/public-config", (request, response, { env }) =>
  sendJson(response, 200, {
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY
  })
);

// Email + password sign-in / refresh, proxied server-side to Supabase Auth so
// the client stays same-origin under the strict CSP. Logic in auth-routes.mjs.
registerAuthRoutes(userRouter, { sendJson, readBody });

// GET /me — the signed-in user plus the facilities they can act in. Logic in
// me-route.mjs; used by the end-user app to populate its facility switcher.
registerMeRoute(userRouter, { authenticate, sendJson });

// Daily Reports: template list/fetch, draft create/edit, and immutable submit.
registerReportRoutes(userRouter, { authenticate, sendJson, readBody });
// Incidents: capture + escalation queue (incidents.read / incidents.manage).
registerIncidentRoutes(userRouter, { authenticate, sendJson, readBody });
// Work orders: dashboard list, create (incl. from incidents), status updates.
registerWorkOrderRoutes(userRouter, { authenticate, sendJson, readBody });
// Scheduling: periods, shifts, and publish-readiness/conflict validation.
registerSchedulingRoutes(userRouter, { authenticate, sendJson, readBody });
// Communications: messages + acknowledgements (communications.read / .publish).
registerCommunicationRoutes(userRouter, { authenticate, sendJson, readBody });
// Training: courses, assignments, and completions (training.read / .manage).
registerTrainingRoutes(userRouter, { authenticate, sendJson, readBody });
// Attachments (OP-17): upload/list/signed-url for reports, incidents, and
// work orders. No readBody -- uploads are raw binary read directly off the
// request stream, never JSON.
registerAttachmentRoutes(userRouter, { authenticate, sendJson });

// Internal, CRON_SECRET-guarded notification drain (OP-13/OP-14): POST and
// GET /api/v1/internal/notifications/drain. Deliberately bypasses the
// `authenticate` (facility-token/JWT) pipeline every route above uses -- see
// src/lib/http/internal-routes.mjs for the auth contract. GET exists because
// Vercel Cron always invokes via GET; POST exists for manual/local/test
// invocation.
registerInternalRoutes(userRouter, { sendJson });

function logRequest(request, path, status, startTime, requestId, userId) {
  try {
    const duration = Date.now() - startTime;
    console.log(JSON.stringify({
      method: request.method,
      path,
      status,
      duration_ms: duration,
      request_id: requestId,
      user_id: userId
    }));
  } catch {
    // Never let logging errors bubble up
  }
}

function serveStatic(request, response) {
  const requestedPath = normalize(new URL(request.url ?? "/", `http://localhost:${port}`).pathname);
  if (requestedPath.includes("..")) {
    response.writeHead(404, securityHeaders);
    response.end("Not found");
    return;
  }
  let filePath = join(root, requestedPath === "/" ? "index.html" : requestedPath);
  let stats;
  try {
    stats = existsSync(filePath) ? statSync(filePath) : null;
  } catch {
    stats = null;
  }
  if (stats && stats.isDirectory()) {
    filePath = join(filePath, "index.html");
    try {
      stats = existsSync(filePath) ? statSync(filePath) : null;
    } catch {
      stats = null;
    }
  }
  if (!stats || !stats.isFile()) {
    response.writeHead(404, securityHeaders);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": contentTypes[extname(filePath)] ?? "text/plain"
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(404, securityHeaders);
    response.end();
  });
  response.on("error", () => stream.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

// Core request dispatch, shared by the long-running Node server (createApp) and
// the Vercel serverless function (api/[...path].mjs). Routes /api/admin/v1/*
// to the admin router and /api/v1/* to the end-user router; anything else falls
// through to static file serving (used only by the Node server — on Vercel the
// platform serves dist/ and this function only ever receives /api/* requests).
export async function handleRequest(request, response) {
  const startTime = Date.now();
  const requestId = randomUUID();
  let path = null;


  try {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    const matchesPrefix = (prefix) =>
      url.pathname.startsWith(`${prefix}/`) || url.pathname === prefix;
    // Admin prefix is checked first; the two prefixes are disjoint
    // ("/api/admin/v1..." never matches "/api/v1" and vice versa).
    path = url.pathname;
    const active = matchesPrefix(apiPrefix)
      ? { prefix: apiPrefix, router }
      : matchesPrefix(userApiPrefix)
        ? { prefix: userApiPrefix, router: userRouter }
        : null;
    if (!active) {
      serveStatic(request, response);
      return;
    }

    const { env, error: envError } = loadEnv();
    if (envError) {
      sendJson(response, 503, { error: "server environment is not configured", detail: envError.message });
      return;
    }

    const routeUrl = url.pathname.slice(active.prefix.length) || "/";
    const matchResult = active.router.match({
      method: request.method,
      url: `${routeUrl}${url.search}`
    });
    if (!matchResult.handler) {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    // Use the matched route template, or fall back to the pathname
    path = matchResult.template || url.pathname;

    try {
      await matchResult.handler(request, response, { env, params: matchResult.params });
    } catch (error) {
      // OP-20 fire-and-forget error report. Never awaited: it must not delay
      // (or, if it fails/times out, ever affect) the 500 response this error
      // is about to produce via createApp's catch / the Vercel serverless
      // catch in api/[...path].mjs. The error is always rethrown unchanged
      // immediately after. Marking it here stops those outer, last-resort
      // catches from reporting the identical error a second time, while
      // still leaving them free to report anything that escapes from
      // *outside* this specific try (a defense-in-depth net, not the common
      // case -- see their own reportError calls).
      reportError(error, {
        dsn: env.OBSERVABILITY_DSN,
        route: path,
        status: 500,
        requestId,
        userId: request.authenticatedUserId ?? null
      });
      error.__observabilityReported = true;
      throw error;
    }
  } finally {
    // Always log, even if the handler threw. Never log request bodies, query
    // strings, auth headers, or env values — only the fields below.
    //
    // The user id comes from authenticate(), which stashes the subject it
    // verified on the request. Re-verifying the token here would both double
    // the crypto work on every authenticated request and risk logging an
    // identity the route itself rejected; unauthenticated (or rejected)
    // requests simply log null.
    logRequest(
      request,
      path || "/",
      response.statusCode || 500,
      startTime,
      requestId,
      request.authenticatedUserId ?? null
    );
  }
}

export function createApp() {
  return createServer((request, response) => {
    Promise.resolve()
      .then(() => handleRequest(request, response))
      .catch((error) => {
        // Defense-in-depth net: handleRequest's own try/catch around the
        // matched route handler already reports (and marks) the common case.
        // This only reports something that escaped from outside that try
        // (e.g. a bug in routing/env-loading itself) so it is not lost, and
        // never double-reports the common case. No `env` is reliably
        // available this far out, so this reads OBSERVABILITY_DSN directly
        // off process.env rather than going through readServerEnv.
        if (!error.__observabilityReported) {
          reportError(error, { dsn: process.env.OBSERVABILITY_DSN, route: null, status: 500, requestId: null, userId: null });
        }
        if (!response.headersSent) {
          sendJson(response, 500, { error: "internal server error", detail: error.message });
        } else {
          response.end();
        }
      });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const app = createApp();
  app.listen(port, () => console.log(`Rec Reports admin server available at http://localhost:${port}`));
}
