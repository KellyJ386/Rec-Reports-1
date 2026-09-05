import { createRateLimiter } from "./rate-limit.mjs";
import {
  REFRESH_COOKIE_NAME,
  buildRefreshCookie,
  clearRefreshCookie,
  parseCookies
} from "./cookies.mjs";

// Server-side authentication proxy for the email + password sign-in flow.
//
// The browser never talks to Supabase Auth (GoTrue) directly: the strict
// `default-src 'self'` CSP forbids cross-origin calls, and we do not want to
// ship a bundler or the supabase-js client. Instead the login page POSTs
// credentials to these same-origin endpoints, which forward to GoTrue using the
// anon key and return the resulting session. The access token is then stored
// client-side under the existing `rr_admin_token` key and sent as a bearer
// token to /api/admin/v1/* and /api/v1/*, where auth.mjs verifies it.
//
// Refresh token (S-11): the response body never carries `refresh_token` --
// it travels only in an HttpOnly `rr_refresh` cookie (see ./cookies.mjs), so
// XSS that steals the access token from localStorage cannot also mint a new
// indefinite session. /auth/refresh reads the cookie, not the body; a
// `refresh_token` in the body is accepted for one release as a migration
// path for sessions that signed in before this change (removed in Wave 2).
//
// Injected primitives match the other route modules:
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Brute-force throttle (OP-23)
// -----------------------------------------------------------------------
// POST /auth/sign-in is throttled by two independent sliding-window
// counters -- per email and per client IP -- built on the bounded,
// in-memory limiter in ./rate-limit.mjs. See that file for why this is a
// single-instance speed bump on Vercel serverless, not a durable global
// rate limit, and how the underlying store stays bounded under attack.
//
// `now` and the limit/window sizes are constructor options specifically so
// tests can inject a fake, steppable clock and tiny windows instead of
// sleeping in real time; production callers (scripts/server.mjs) get the
// defaults below by omitting them.
export function registerAuthRoutes(
  router,
  { sendJson, readBody, now = Date.now, signInRateLimit = {} }
) {
  const emailLimiter = createRateLimiter({
    windowMs: signInRateLimit.emailWindowMs ?? 15 * 60 * 1000,
    max: signInRateLimit.emailMax ?? 5,
    now,
    sweepEvery: signInRateLimit.sweepEvery ?? 500
  });
  // The per-IP ceiling is intentionally higher than the per-email one: one
  // office/NAT full of legitimate users can share an IP, but no legitimate
  // user fails the same account 5+ times in 15 minutes.
  const ipLimiter = createRateLimiter({
    windowMs: signInRateLimit.ipWindowMs ?? 15 * 60 * 1000,
    max: signInRateLimit.ipMax ?? 20,
    now,
    sweepEvery: signInRateLimit.sweepEvery ?? 500
  });

  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  // Behind Vercel, x-forwarded-for's leftmost entry is the client IP Vercel's
  // edge network observed. It is still just a request header: nothing stops
  // a caller from sending their own x-forwarded-for to a deployment that
  // isn't behind Vercel, and even on Vercel the value is attacker-supplied
  // in the sense that it's never cryptographically verified. Treat it as a
  // throttle *bucket*, never as an identity or an audit fact -- worst case
  // a spoofed value just gives an attacker their own private bucket, which
  // is no worse than having no per-IP throttle at all for that request.
  function clientIp(request) {
    const header = request.headers?.["x-forwarded-for"];
    if (header) {
      const first = String(header).split(",")[0]?.trim();
      if (first) return first;
    }
    return request.socket?.remoteAddress || "unknown";
  }

  function normalizeEmail(email) {
    return String(email).trim().toLowerCase();
  }

  // Whether the refresh cookie should carry `Secure`. Real deployments (Vercel
  // and anything behind a TLS-terminating proxy) set `x-forwarded-proto`, so
  // that wins first; a direct TLS listener with no proxy in front falls back
  // to the raw socket's `encrypted` flag; failing both (no proxy header, plain
  // HTTP socket) the only case allowed to omit `Secure` is local dev over
  // `http://localhost` -- every other host defaults to secure so a
  // misconfigured/absent proxy header never silently downgrades a cookie sent
  // to a real domain.
  function isSecureRequest(request) {
    const forwardedProto = request.headers?.["x-forwarded-proto"];
    if (forwardedProto) {
      return (
        String(forwardedProto)
          .split(",")[0]
          .trim()
          .toLowerCase() === "https"
      );
    }
    if (request.socket?.encrypted !== undefined) {
      return !!request.socket.encrypted;
    }
    const host = String(request.headers?.host || "")
      .split(":")[0]
      .toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1";
  }

  // CSRF check for /auth/refresh: `SameSite=Strict` already stops the cookie
  // from riding along on a cross-site navigation or fetch in any modern
  // browser, but `Strict` cookies are still attached to same-site requests
  // and (in older/non-compliant clients) `sec-fetch-site` may be the only
  // signal available -- so this is defense in depth, not the only guard.
  // Missing header (older browsers, some non-browser clients) fails open on
  // purpose: it is the same trust boundary SameSite=Strict already draws.
  function isSameSiteRequest(request) {
    const secFetchSite = request.headers?.["sec-fetch-site"];
    if (!secFetchSite) return true;
    const value = String(secFetchSite).trim().toLowerCase();
    return value === "same-origin" || value === "none";
  }

  function retryAfterSeconds(retryAfterMs) {
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }

  // Same response for "this email is locked out" and "this IP is locked
  // out" -- the caller cannot tell which counter tripped, so the 429 can't
  // be used to fingerprint whether `email` is a real account (an attacker
  // sees the exact same status/body/header shape either way). See the
  // account-existence note above the sign-in handler for the matching
  // point about the 401 body.
  function sendThrottled(response, retryAfterMs) {
    response.setHeader?.("Retry-After", String(retryAfterSeconds(retryAfterMs)));
    return sendJson(response, 429, { error: "too many attempts, try again later" });
  }

  function gotrue(env, path) {
    const base = String(env.SUPABASE_URL).replace(/\/+$/, "");
    return `${base}/auth/v1/${path}`;
  }

  function anonKey(env) {
    return env.SUPABASE_ANON_KEY;
  }

  // Shapes the session GoTrue returns into the minimal payload the client
  // needs. access_token is what the app's JWT verifier consumes.
  // `refresh_token` never appears here (S-11) -- it only ever travels as the
  // HttpOnly `rr_refresh` cookie set alongside this body.
  function sessionPayload(data) {
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? "bearer",
      expires_in: data.expires_in ?? null,
      expires_at: data.expires_at ?? null,
      user: data.user ? { id: data.user.id, email: data.user.email } : null
    };
  }

  // `authorization` overrides the anon-key bearer with the caller's own access
  // token, which GoTrue requires for user-scoped calls such as logout.
  async function callGotrue(env, path, body, { authorization } = {}) {
    let response;
    try {
      response = await fetch(gotrue(env, path), {
        method: "POST",
        headers: {
          apikey: anonKey(env),
          Authorization: authorization ?? `Bearer ${anonKey(env)}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch {
      // Network/DNS/TLS failure reaching Supabase Auth.
      return { ok: false, status: 502, data: { error: "auth_upstream_unreachable" } };
    }
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // GoTrue (or an upstream proxy) can answer with a non-JSON body on
        // error; treat it as an opaque failure rather than throwing.
        data = { error: "non_json_response" };
      }
    }
    return { ok: response.ok, status: response.status, data };
  }

  function requireConfigured(env, response) {
    if (!env.SUPABASE_URL || !anonKey(env)) {
      sendJson(response, 503, { error: "authentication is not configured" });
      return false;
    }
    return true;
  }

  // POST /auth/sign-in { email, password } -> session
  //
  // Account-existence note: GoTrue itself already answers "wrong password"
  // and "no such user" with the same invalid_grant error, and that maps to
  // the same generic 401 body below either way -- this route never learns,
  // let alone reveals, whether `email` is registered. Only FAILED attempts
  // (this 401 branch) increment the throttle counters; a successful
  // sign-in clears the email counter but leaves the IP counter alone,
  // since a shared/NAT IP with other legitimate traffic shouldn't be reset
  // by one account's success.
  //
  // Timing: a throttled request returns 429 immediately, before calling
  // GoTrue at all -- both to avoid hammering the upstream while under
  // attack, and because there is nothing useful left to check once a
  // bucket is exhausted. That does make a 429 measurably faster than a 401
  // (which makes a real network round trip to GoTrue). We deliberately do
  // not paper over that with an artificial sleep: the status code already
  // tells a caller "you're rate-limited" in plain text, so hiding the
  // *timing* of that fact buys nothing, and a multi-second synthetic delay
  // would only punish legitimate users retrying after a typo. What must
  // stay uniform -- and does -- is that the 429 fires the same way and
  // carries the same body regardless of whether `email` belongs to a real
  // account.
  router.register("POST", "/auth/sign-in", (request, response, { env }) =>
    (async () => {
      if (!requireConfigured(env, response)) return;
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { email, password } = body.payload;
      if (!email || !password) {
        return sendJson(response, 400, { errors: ["email and password are required"] });
      }

      const ip = clientIp(request);
      const emailKey = normalizeEmail(email);

      const ipCheck = ipLimiter.check(ip);
      const emailCheck = emailLimiter.check(emailKey);
      if (ipCheck.blocked || emailCheck.blocked) {
        const retryAfterMs = Math.max(ipCheck.retryAfterMs, emailCheck.retryAfterMs);
        return sendThrottled(response, retryAfterMs);
      }

      const result = await callGotrue(env, "token?grant_type=password", { email, password });
      if (!result.ok) {
        ipLimiter.recordFailure(ip);
        emailLimiter.recordFailure(emailKey);
        return sendJson(response, 401, { error: "invalid email or password" });
      }
      emailLimiter.reset(emailKey);
      response.setHeader?.(
        "Set-Cookie",
        buildRefreshCookie({ token: result.data.refresh_token, secure: isSecureRequest(request) })
      );
      return sendJson(response, 200, sessionPayload(result.data));
    })()
  );

  // POST /auth/refresh {} -> session
  //
  // The refresh token itself comes from the HttpOnly `rr_refresh` cookie, not
  // the body -- the body fallback below exists only so sessions started
  // before this change (refresh token still in the client's localStorage)
  // keep working for one release; remove the fallback in Wave 2 once every
  // live session has rotated through the cookie at least once.
  router.register("POST", "/auth/refresh", (request, response, { env }) =>
    (async () => {
      if (!requireConfigured(env, response)) return;
      if (!isSameSiteRequest(request)) {
        return sendJson(response, 403, { error: "cross-site request" });
      }
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const cookies = parseCookies(request.headers?.cookie);
      const refreshToken = cookies[REFRESH_COOKIE_NAME] || body.payload.refresh_token;
      if (!refreshToken) {
        return sendJson(response, 400, { errors: ["refresh_token is required"] });
      }
      const secure = isSecureRequest(request);
      const result = await callGotrue(env, "token?grant_type=refresh_token", {
        refresh_token: refreshToken
      });
      if (!result.ok) {
        // The refresh token was rejected (expired/revoked/reused) -- drop the
        // cookie so the browser stops offering a token GoTrue will never
        // accept again.
        response.setHeader?.("Set-Cookie", clearRefreshCookie({ secure }));
        return sendJson(response, 401, { error: "could not refresh session" });
      }
      response.setHeader?.(
        "Set-Cookie",
        buildRefreshCookie({ token: result.data.refresh_token, secure })
      );
      return sendJson(response, 200, sessionPayload(result.data));
    })()
  );

  // POST /auth/sign-out -> revokes the caller's refresh token upstream.
  //
  // Always answers 200: the browser clears its own copy of the session either
  // way, so a token GoTrue has already forgotten (expired, revoked, missing
  // header) is not an error the user can act on. Signing out must never fail.
  router.register("POST", "/auth/sign-out", (request, response, { env }) =>
    (async () => {
      if (!requireConfigured(env, response)) return;
      const authorization = request.headers?.authorization;
      if (authorization) {
        await callGotrue(env, "logout", {}, { authorization });
      }
      response.setHeader?.("Set-Cookie", clearRefreshCookie({ secure: isSecureRequest(request) }));
      return sendJson(response, 200, { signed_out: true });
    })()
  );

  return router;
}
