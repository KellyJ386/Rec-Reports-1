#!/usr/bin/env node
// Post-deploy smoke test script for basic API health checks.
// Usage: node scripts/smoke.mjs [baseUrl]
// Environment variables:
//   SMOKE_BASE_URL: base URL (falls back to first CLI arg or http://localhost:8000)
//   SMOKE_EMAIL: email for sign-in test
//   SMOKE_PASSWORD: password for sign-in test

const baseUrl = process.env.SMOKE_BASE_URL ?? process.argv[2] ?? "http://localhost:8000";
const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

let testsPassed = 0;
let testsFailed = 0;

// Export for testing
export function assertStep(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return true;
  } else {
    console.log(`FAIL ${name}: ${detail}`);
    return false;
  }
}

async function step(name, fn) {
  try {
    const result = await fn();
    if (assertStep(name, result.ok, result.detail)) {
      testsPassed++;
      return result.data;
    } else {
      testsFailed++;
      return null;
    }
  } catch (error) {
    if (assertStep(name, false, error.message)) {
      testsPassed++;
    } else {
      testsFailed++;
    }
    return null;
  }
}

async function runTests() {
  console.log(`Smoke tests targeting ${baseUrl}\n`);

  // Step 1: GET /api/v1/public-config
  const config = await step("GET /api/v1/public-config", async () => {
    const response = await fetch(`${baseUrl}/api/v1/public-config`);
    if (response.status !== 200) {
      return { ok: false, detail: `expected 200, got ${response.status}` };
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, detail: "response is not valid JSON" };
    }
    return { ok: true, data };
  });

  if (!config) {
    testsFailed++;
    console.error("Cannot proceed: public-config step failed\n");
    process.exit(1);
  }

  // Step 2: POST /api/v1/auth/sign-in
  let token = null;
  if (email && password) {
    const session = await step("POST /api/v1/auth/sign-in", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/sign-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (response.status !== 200) {
        return { ok: false, detail: `expected 200, got ${response.status}` };
      }
      let data;
      try {
        data = await response.json();
      } catch {
        return { ok: false, detail: "response is not valid JSON" };
      }
      if (!data.access_token) {
        return { ok: false, detail: "response missing access_token" };
      }
      return { ok: true, data };
    });

    if (session) {
      token = session.access_token;

      // Step 3: GET /api/v1/me with bearer token
      const me = await step("GET /api/v1/me (with auth)", async () => {
        const response = await fetch(`${baseUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status !== 200) {
          return { ok: false, detail: `expected 200, got ${response.status}` };
        }
        let data;
        try {
          data = await response.json();
        } catch {
          return { ok: false, detail: "response is not valid JSON" };
        }
        return { ok: true, data };
      });

      if (!me) {
        testsFailed++;
        console.error("Cannot proceed: /me step failed\n");
        process.exit(1);
      }

      // Extract first facility ID for work-orders test
      let facilityId = null;
      if (me.memberships && me.memberships.length > 0) {
        facilityId = me.memberships[0].facilityId;
      }

      // Step 4: GET admin endpoint (e.g., /api/admin/v1/me)
      await step("GET /api/admin/v1/me (admin check)", async () => {
        const response = await fetch(`${baseUrl}/api/admin/v1/me`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status !== 200) {
          return { ok: false, detail: `expected 200, got ${response.status}` };
        }
        let data;
        try {
          data = await response.json();
        } catch {
          return { ok: false, detail: "response is not valid JSON" };
        }
        return { ok: true, data };
      });

      // Step 5: GET /api/v1/facilities/{facilityId}/work-orders
      if (facilityId) {
        await step(`GET /api/v1/facilities/${facilityId}/work-orders`, async () => {
          const response = await fetch(`${baseUrl}/api/v1/facilities/${facilityId}/work-orders`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (response.status !== 200) {
            return { ok: false, detail: `expected 200, got ${response.status}` };
          }
          let data;
          try {
            data = await response.json();
          } catch {
            return { ok: false, detail: "response is not valid JSON" };
          }
          return { ok: true, data };
        });
      } else {
        console.log("SKIP GET /api/v1/facilities/{id}/work-orders (no facility found in memberships)");
      }
    } else {
      testsFailed++;
      console.error("Cannot proceed: sign-in step failed\n");
      process.exit(1);
    }
  } else {
    console.log("SKIP POST /api/v1/auth/sign-in (SMOKE_EMAIL or SMOKE_PASSWORD not set)");
    console.log("SKIP GET /api/v1/me (auth required)");
    console.log("SKIP GET /api/admin/v1/me (auth required)");
    console.log("SKIP GET /api/v1/facilities/{id}/work-orders (auth required)");
  }

  console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) {
    process.exit(1);
  }
}

// Only run tests if this module is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch((error) => {
    console.error("Smoke test error:", error.message);
    process.exit(1);
  });
}
