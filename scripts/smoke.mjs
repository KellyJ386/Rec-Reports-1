// Post-deploy smoke test for a live Rec Reports deployment.
//
// Exercises the critical path end-to-end against a running URL and prints a
// pass/fail report with actionable diagnosis — especially for the one failure
// mode most likely after deploy: SUPABASE_JWT_SECRET missing or not matching
// the algorithm the project signs tokens with (HS256 legacy secret vs ES256).
//
// Usage:
//   node scripts/smoke.mjs <baseUrl> <email> <password>
//   SMOKE_URL=https://... SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/smoke.mjs
//
// Exits 0 if every check passes, 1 otherwise. Reads/writes nothing; it only
// makes HTTP requests to the URL you give it.

const args = process.argv.slice(2);
const baseUrl = (args[0] ?? process.env.SMOKE_URL ?? "").replace(/\/+$/, "");
const email = args[1] ?? process.env.SMOKE_EMAIL ?? "";
const password = args[2] ?? process.env.SMOKE_PASSWORD ?? "";

if (!baseUrl || !email || !password) {
  console.error("usage: node scripts/smoke.mjs <baseUrl> <email> <password>");
  console.error("   or: SMOKE_URL, SMOKE_EMAIL, SMOKE_PASSWORD env vars");
  process.exit(2);
}

let passed = 0;
let failed = 0;

function ok(label, detail) {
  passed += 1;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail, hint) {
  failed += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  if (hint) console.log(`      → ${hint}`);
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    return { networkError: error.message };
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function main() {
  console.log(`Rec Reports smoke test against ${baseUrl}\n`);

  // 1) Public config — proves the deployment is up and the public env vars are set.
  const cfg = await req("GET", "/api/v1/public-config");
  if (cfg.networkError) {
    fail("public-config reachable", cfg.networkError, "Is the URL correct and the deploy live?");
    return finish();
  }
  if (cfg.status === 200 && cfg.json?.supabaseUrl && cfg.json?.supabaseAnonKey) {
    ok("public-config", "NEXT_PUBLIC_SUPABASE_URL + anon key are configured");
  } else {
    fail(
      "public-config",
      `HTTP ${cfg.status}`,
      "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the deployment env."
    );
  }

  // 2) Sign-in — proves Supabase Auth is reachable and the credentials are valid.
  const signIn = await req("POST", "/api/v1/auth/sign-in", { body: { email, password } });
  const token = signIn.json?.access_token;
  if (signIn.status === 200 && token) {
    ok("sign-in", "email + password accepted, access token issued");
  } else if (signIn.status === 401) {
    fail("sign-in", "HTTP 401", "Wrong email/password, or the auth user does not exist.");
    return finish();
  } else if (signIn.status === 503) {
    fail("sign-in", "HTTP 503", "Supabase env not configured on the server.");
    return finish();
  } else {
    fail("sign-in", `HTTP ${signIn.status}`, "Unexpected sign-in failure; check server logs.");
    return finish();
  }

  // 3) /me with the token — THE key check. A 401 here means the server minted a
  //    token the app's verifier rejects: SUPABASE_JWT_SECRET is missing or does
  //    not match the algorithm the project signs with.
  const me = await req("GET", "/api/v1/me", { token });
  if (me.status === 200 && Array.isArray(me.json?.facilities)) {
    ok("authenticated /me", `${me.json.facilities.length} facility(ies), platformAdmin=${me.json.platformAdmin}`);
  } else if (me.status === 401 || me.status === 503) {
    fail(
      "authenticated /me",
      `HTTP ${me.status}`,
      "SUPABASE_JWT_SECRET is unset or wrong. Set it to the project's JWT secret " +
        "(Supabase → Settings → API → JWT Secret). If the project uses ES256/JWKS " +
        "signing, enable the legacy HS256 secret or extend auth.mjs for JWKS."
    );
    return finish();
  } else {
    fail("authenticated /me", `HTTP ${me.status}`, "Unexpected; check server logs.");
    return finish();
  }

  // 4) End-user API + RLS — list templates for the first facility.
  const facilityId = me.json.facilities[0]?.id;
  if (facilityId) {
    const templates = await req("GET", `/api/v1/facilities/${facilityId}/report-templates`, { token });
    if (templates.status === 200 && Array.isArray(templates.json)) {
      ok("end-user API", `report-templates returned ${templates.json.length} row(s)`);
    } else {
      fail("end-user API", `HTTP ${templates.status}`, "Check RLS/permissions for this facility.");
    }
  } else {
    fail("end-user API", "no facility on /me", "The signed-in user has no facility membership.");
  }

  // 5) Admin API — proves the admin surface authenticates the same token.
  const modules = await req("GET", "/api/admin/v1/modules", { token });
  if (modules.status === 200) {
    ok("admin API", "modules endpoint authenticated");
  } else {
    fail("admin API", `HTTP ${modules.status}`, "Admin API rejected the token.");
  }

  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
