import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PostgrestError } from "../src/lib/supabase-rest.mjs";
import { translatePostgrestError, includeErrorDetail, isQueryShapeError } from "../src/lib/http/errors.mjs";
import { handleRequest } from "../scripts/server.mjs";

function postgrestError(status, body) {
  return new PostgrestError(`PostgREST GET some_table failed with status ${status}`, { status, body });
}

// --- translatePostgrestError ---------------------------------------------

test("translatePostgrestError returns null for a plain (non-PostgrestError) error", () => {
  assert.equal(translatePostgrestError(new Error("boom")), null);
  assert.equal(translatePostgrestError(new TypeError("boom")), null);
  assert.equal(translatePostgrestError("not even an error"), null);
  assert.equal(translatePostgrestError(null), null);
  assert.equal(translatePostgrestError(undefined), null);
});

test("translatePostgrestError maps 409 to a conflict", () => {
  assert.deepEqual(translatePostgrestError(postgrestError(409, { message: "duplicate key" })), {
    status: 409,
    body: { error: "conflict" }
  });
});

test("translatePostgrestError maps 400 and 422 to a single invalid-request shape", () => {
  const expected = { status: 400, body: { error: "invalid request" } };
  assert.deepEqual(translatePostgrestError(postgrestError(400, { message: "bad column" })), expected);
  assert.deepEqual(translatePostgrestError(postgrestError(422, { message: "constraint" })), expected);
});

test("translatePostgrestError maps 401 to unauthorized", () => {
  assert.deepEqual(translatePostgrestError(postgrestError(401, { message: "JWT expired" })), {
    status: 401,
    body: { error: "unauthorized" }
  });
});

test("translatePostgrestError maps 403 (RLS WITH CHECK denial) to forbidden", () => {
  assert.deepEqual(translatePostgrestError(postgrestError(403, { code: "42501", message: "new row violates policy" })), {
    status: 403,
    body: { error: "forbidden" }
  });
});

test("translatePostgrestError maps 404 PGRST205 (unknown table) to a 500 server-bug shape", () => {
  const result = translatePostgrestError(
    postgrestError(404, { code: "PGRST205", message: "Could not find the table 'x' in the schema cache" })
  );
  assert.deepEqual(result, { status: 500, body: { error: "internal server error" } });
});

test("translatePostgrestError keeps query-shape errors (undefined column/table/function, bad filter syntax) as 500 even when PostgREST answers 400", () => {
  const cases = [
    ["42703", 'column "facilty_id" does not exist'],
    ["42P01", 'relation "work_order" does not exist'],
    ["42883", "function public.apply_incident_amendmnt(uuid, jsonb, text) does not exist"],
    ["PGRST100", '"failed to parse filter (eq.)" (line 1, column 4)'],
    ["PGRST204", "Could not find the 'facilty_id' column of 'work_orders' in the schema cache"]
  ];
  for (const [code, message] of cases) {
    const translated = translatePostgrestError(postgrestError(400, { code, message }));
    assert.equal(translated.status, 500, `${code} must not be blamed on the caller`);
    assert.deepEqual(translated.body, { error: "internal server error" });
    assert.equal(isQueryShapeError(postgrestError(400, { code, message })), true);
  }
});

test("translatePostgrestError still maps a caller-supplied bad value (22P02 invalid uuid) to 400", () => {
  const translated = translatePostgrestError(
    postgrestError(400, { code: "22P02", message: 'invalid input syntax for type uuid: "nope"' })
  );
  assert.deepEqual(translated, { status: 400, body: { error: "invalid request" } });
});

test("translatePostgrestError does not treat every 404 as the PGRST205 server-bug case", () => {
  // A 404 without that specific code is still an ordinary "everything else"
  // PostgrestError -- this function has no opinion on route-level "row not
  // found for this caller" 404s (those never even reach here: a filtered
  // SELECT returns 200 with zero rows, per this module's own doc comment).
  const result = translatePostgrestError(postgrestError(404, { code: "PGRST116", message: "no rows" }));
  assert.deepEqual(result, { status: 500, body: { error: "internal server error" } });
});

test("translatePostgrestError maps an unmapped status (e.g. 500, 503) to the generic 500 shape", () => {
  assert.deepEqual(translatePostgrestError(postgrestError(500, { message: "connection reset" })), {
    status: 500,
    body: { error: "internal server error" }
  });
  assert.deepEqual(translatePostgrestError(postgrestError(503, { message: "unavailable" })), {
    status: 500,
    body: { error: "internal server error" }
  });
});

// --- includeErrorDetail (production detail-leak guard) --------------------

test("includeErrorDetail shows detail when VERCEL_ENV is unset (local/dev default)", () => {
  assert.equal(includeErrorDetail({}), true);
});

test("includeErrorDetail shows detail on Vercel preview deployments", () => {
  assert.equal(includeErrorDetail({ VERCEL_ENV: "preview" }), true);
});

test("includeErrorDetail hides detail on Vercel production", () => {
  assert.equal(includeErrorDetail({ VERCEL_ENV: "production" }), false);
});

test("includeErrorDetail's DEBUG_ERRORS overrides production back to showing detail", () => {
  assert.equal(includeErrorDetail({ VERCEL_ENV: "production", DEBUG_ERRORS: "1" }), true);
  assert.equal(includeErrorDetail({ VERCEL_ENV: "production", DEBUG_ERRORS: "true" }), true);
});

test("includeErrorDetail treats DEBUG_ERRORS=false/0/empty as not set (the string-\"false\" footgun)", () => {
  assert.equal(includeErrorDetail({ VERCEL_ENV: "production", DEBUG_ERRORS: "false" }), false);
  assert.equal(includeErrorDetail({ VERCEL_ENV: "production", DEBUG_ERRORS: "0" }), false);
  assert.equal(includeErrorDetail({ VERCEL_ENV: "production", DEBUG_ERRORS: "" }), false);
});

// --- Integration: scripts/server.mjs's handleRequest -----------------------
// These drive the real route dispatch (router match -> registered handler ->
// handleRequest's own catch) with a hand-built request/response pair, the
// same primitives node:http's real IncomingMessage/ServerResponse expose
// that handleRequest/sendJson actually touch, and a stubbed global.fetch
// standing in for PostgREST -- no real network, no spawned server process
// (contrast test/server-logging.test.mjs and test/server-headers.test.mjs,
// which spawn the real binary because they're proving process-level
// behavior; this is proving in-process dispatch logic instead).

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

// A minimal HS256 Supabase-shaped access token: iss is REQUIRED since S-13
// (allowedIssuers in auth.mjs) -- "supabase" is the legacy value every
// project accepts regardless of its own SUPABASE_URL.
function makeAccessToken(secret, { sub = "user-1", iss = "supabase", expiresInSeconds = 3600 } = {}) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ sub, iss, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function fakeResponse() {
  return {
    headersSent: false,
    statusCode: 200,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      Object.assign(this.headers, headers ?? {});
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
    on() {},
    json() {
      return JSON.parse(this.body ?? "null");
    }
  };
}

function fakeRequest(method, url, { headers = {} } = {}) {
  return { method, url, headers, on() {} };
}

// Saves and restores every env var this section touches, and global.fetch,
// around one test -- t.after runs even if the test throws/rejects.
function withEnv(t, overrides) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function stubFetch(t, respond) {
  const captured = { postgrest: [], observability: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "observability.example") {
      captured.observability.push({ body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, text: async () => "" };
    }
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.postgrest.push({ table, method });
    const result = respond(table, method, parsed);
    if (result?.error) {
      return { ok: false, status: result.status, text: async () => JSON.stringify(result.body ?? {}) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

test("handleRequest translates a PostgrestError from an ordinary (authenticate()-gated) route to a clean 4xx, and does not report it", async (t) => {
  withEnv(t, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_JWT_SECRET: "test-jwt-secret",
    OBSERVABILITY_DSN: "https://observability.example/report"
  });
  const captured = stubFetch(t, (table) => {
    if (table === "memberships") return [];
    if (table === "platform_admins") return [];
    // Simulates an RLS WITH CHECK denial surfacing on a route (GET /modules
    // in scripts/server.mjs) that has no try/catch of its own around its
    // pgSelect call -- the central catch in handleRequest is the only thing
    // standing between this and an unhandled-error 500.
    if (table === "modules") return { error: true, status: 403, body: { code: "42501", message: "denied" } };
    return [];
  });

  const token = makeAccessToken("test-jwt-secret");
  const request = fakeRequest("GET", "/api/admin/v1/modules", { headers: { authorization: `Bearer ${token}` } });
  const response = fakeResponse();

  await handleRequest(request, response);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: "forbidden" });
  assert.equal(captured.observability.length, 0, "a translated 4xx must never be reported as a server error");
});

test("handleRequest never translates a PostgrestError from an /internal/ (service-role, CRON_SECRET) route -- it stays a reported 5xx", async (t) => {
  // Hard requirement (P-9): a PostgrestError raised on a service-role path
  // (the notifications worker, driven here through the real internal drain
  // route) must still surface as 5xx and be reported, never masked as a
  // client 4xx just because its PostgREST status code (409) would normally
  // translate to one for an ordinary caller-scoped route.
  withEnv(t, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    CRON_SECRET: "test-cron-secret",
    OBSERVABILITY_DSN: "https://observability.example/report"
  });
  const captured = stubFetch(t, (table) => {
    // The drain's first PostgREST call (claimDueOutboxEvents, GET
    // outbox_events) fails with 409 -- a status translatePostgrestError
    // would normally map to 409 {error: "conflict"} for a caller-scoped
    // route. It must not be given the chance to here.
    if (table === "outbox_events") {
      return { error: true, status: 409, body: { code: "23505", message: "duplicate key" } };
    }
    return [];
  });

  const request = fakeRequest("GET", "/api/v1/internal/notifications/drain", {
    headers: { authorization: "Bearer test-cron-secret" }
  });
  const response = fakeResponse();

  await assert.rejects(
    () => handleRequest(request, response),
    /PostgREST GET outbox_events failed with status 409/,
    "the PostgrestError must propagate uncaught, exactly as before this task, not be swallowed as a 4xx response"
  );

  // Never answered inline as a translated 4xx -- handleRequest's own catch
  // deliberately does not touch the response for the path this test takes;
  // producing the actual 500 response is scripts/server.mjs's createApp
  // catch (or api/[...path].mjs's), one level up.
  assert.equal(response.headersSent, false);
  assert.equal(captured.observability.length, 1, "expected exactly one fire-and-forget error report");
  assert.equal(captured.observability[0].body.status, 500);
  assert.equal(captured.observability[0].body.route, "/internal/notifications/drain");
});
