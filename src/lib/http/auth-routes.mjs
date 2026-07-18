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
// Injected primitives match the other route modules:
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
export function registerAuthRoutes(router, { sendJson, readBody }) {
  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  function gotrue(env, path) {
    const base = String(env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
    return `${base}/auth/v1/${path}`;
  }

  function anonKey(env) {
    return env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }

  // Shapes the session GoTrue returns into the minimal payload the client
  // needs. access_token is what the app's JWT verifier consumes.
  function sessionPayload(data) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type ?? "bearer",
      expires_in: data.expires_in ?? null,
      expires_at: data.expires_at ?? null,
      user: data.user ? { id: data.user.id, email: data.user.email } : null
    };
  }

  async function callGotrue(env, path, body) {
    let response;
    try {
      response = await fetch(gotrue(env, path), {
        method: "POST",
        headers: {
          apikey: anonKey(env),
          Authorization: `Bearer ${anonKey(env)}`,
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
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !anonKey(env)) {
      sendJson(response, 503, { error: "authentication is not configured" });
      return false;
    }
    return true;
  }

  // POST /auth/sign-in { email, password } -> session
  router.register("POST", "/auth/sign-in", (request, response, { env }) =>
    (async () => {
      if (!requireConfigured(env, response)) return;
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { email, password } = body.payload;
      if (!email || !password) {
        return sendJson(response, 400, { errors: ["email and password are required"] });
      }
      const result = await callGotrue(env, "token?grant_type=password", { email, password });
      if (!result.ok) {
        return sendJson(response, 401, { error: "invalid email or password" });
      }
      return sendJson(response, 200, sessionPayload(result.data));
    })()
  );

  // POST /auth/refresh { refresh_token } -> session
  router.register("POST", "/auth/refresh", (request, response, { env }) =>
    (async () => {
      if (!requireConfigured(env, response)) return;
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const refreshToken = body.payload.refresh_token;
      if (!refreshToken) {
        return sendJson(response, 400, { errors: ["refresh_token is required"] });
      }
      const result = await callGotrue(env, "token?grant_type=refresh_token", {
        refresh_token: refreshToken
      });
      if (!result.ok) {
        return sendJson(response, 401, { error: "could not refresh session" });
      }
      return sendJson(response, 200, sessionPayload(result.data));
    })()
  );

  return router;
}
