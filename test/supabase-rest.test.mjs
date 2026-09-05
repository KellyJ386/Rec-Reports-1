import test from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  pgSelect,
  pgInsert,
  pgUpdate,
  pgDelete,
  PostgrestError
} from "../src/lib/supabase-rest.mjs";

function withFetch(t, implementation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("createClient requires a url and a key", () => {
  assert.throws(() => createClient({ key: "key" }));
  assert.throws(() => createClient({ url: "https://example.supabase.co" }));
});

test("createClient defaults authToken to the key when omitted", () => {
  const client = createClient({ url: "https://example.supabase.co/", key: "service-key" });
  assert.equal(client.authToken, "service-key");
  assert.equal(client.url, "https://example.supabase.co");
});

test("pgSelect builds eq filters, select, order, and limit into the query string", async (t) => {
  let capturedUrl;
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key", authToken: "user-token" });
  await pgSelect(client, "modules", {
    filters: { organization_id: "org-1" },
    select: "id,name",
    order: "category.asc",
    limit: 10
  });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.pathname, "/rest/v1/modules");
  assert.equal(parsed.searchParams.get("organization_id"), "eq.org-1");
  assert.equal(parsed.searchParams.get("select"), "id,name");
  assert.equal(parsed.searchParams.get("order"), "category.asc");
  assert.equal(parsed.searchParams.get("limit"), "10");
  assert.equal(capturedInit.method, "GET");
  assert.equal(capturedInit.headers.apikey, "anon-key");
  assert.equal(capturedInit.headers.Authorization, "Bearer user-token");
});

test("pgInsert posts rows and sets return=representation when returning", async (t) => {
  let capturedUrl;
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 201, text: async () => JSON.stringify([{ id: "1" }]) };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const result = await pgInsert(client, "organization_module_settings", [{ enabled: true }], {
    onConflict: "organization_id,module_id",
    merge: true
  });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.pathname, "/rest/v1/organization_module_settings");
  assert.equal(parsed.searchParams.get("on_conflict"), "organization_id,module_id");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers.apikey, "service-key");
  assert.equal(capturedInit.headers.Authorization, "Bearer service-key");
  assert.match(capturedInit.headers.Prefer, /resolution=merge-duplicates/);
  assert.match(capturedInit.headers.Prefer, /return=representation/);
  assert.equal(capturedInit.body, JSON.stringify([{ enabled: true }]));
  assert.deepEqual(result, [{ id: "1" }]);
});

test("pgUpdate patches filtered rows", async (t) => {
  let capturedUrl;
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "1", enabled: false }]) };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  await pgUpdate(client, "facility_module_overrides", { facility_id: "facility-1" }, { enabled: false });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("facility_id"), "eq.facility-1");
  assert.equal(capturedInit.method, "PATCH");
  assert.equal(capturedInit.body, JSON.stringify({ enabled: false }));
});

test("pgDelete removes filtered rows without returning by default", async (t) => {
  let capturedUrl;
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 204, text: async () => "" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const result = await pgDelete(client, "facility_module_overrides", { id: "row-1" });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("id"), "eq.row-1");
  assert.equal(capturedInit.method, "DELETE");
  assert.equal(capturedInit.headers.Prefer, undefined);
  assert.equal(result, null);
});

test("pgSelect keeps emitting eq. for plain scalar filter values (backward compat)", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "modules", { filters: { organization_id: "org-1", status: "active" } });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("organization_id"), "eq.org-1");
  assert.equal(parsed.searchParams.get("status"), "eq.active");
});

test("pgSelect supports gte/lte range filters via object-tagged values", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "report_submissions", {
    filters: { report_date: { gte: "2026-01-01", lte: "2026-01-31" } }
  });

  const parsed = new URL(capturedUrl);
  assert.deepEqual(parsed.searchParams.getAll("report_date"), ["gte.2026-01-01", "lte.2026-01-31"]);
});

test("pgSelect supports gt and lt filters via object-tagged values", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "work_orders", {
    filters: { due_at: { gt: "2026-01-01T00:00:00Z" }, priority_rank: { lt: 3 } }
  });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("due_at"), "gt.2026-01-01T00:00:00Z");
  assert.equal(parsed.searchParams.get("priority_rank"), "lt.3");
});

test("pgSelect supports neq filters via object-tagged values", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "work_orders", { filters: { status: { neq: "cancelled" } } });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("status"), "neq.cancelled");
});

test("pgSelect supports in filters formatted as in.(a,b)", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "report_submissions", { filters: { status: { in: ["a", "b"] } } });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("status"), "in.(a,b)");
});

test("an unknown filter operator throws before any fetch is issued", async (t) => {
  let fetchCalled = false;
  withFetch(t, async () => {
    fetchCalled = true;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await assert.rejects(() => pgSelect(client, "report_submissions", { filters: { status: { bogus: "x" } } }));
  assert.equal(fetchCalled, false);
});

test("pgSelect builds offset into the query string", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "report_submissions", { limit: 50, offset: 100 });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("limit"), "50");
  assert.equal(parsed.searchParams.get("offset"), "100");
});

test("pgSelect sets a Prefer count header when count option is given", async (t) => {
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedInit = init;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "report_submissions", { count: "exact" });

  assert.match(capturedInit.headers.Prefer, /count=exact/);
});

test("pgSelect omits the Prefer header entirely when no count/returning/prefer options given", async (t) => {
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedInit = init;
    return { ok: true, status: 200, text: async () => "[]" };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await pgSelect(client, "report_submissions", {});

  assert.equal(capturedInit.headers.Prefer, undefined);
});

test("non-2xx responses throw a PostgrestError with status and body", async (t) => {
  withFetch(t, async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ message: "permission denied" })
  }));

  const client = createClient({ url: "https://example.supabase.co", key: "anon-key" });
  await assert.rejects(
    () => pgSelect(client, "organization_module_settings", {}),
    (error) => {
      assert.ok(error instanceof PostgrestError);
      assert.equal(error.status, 403);
      assert.deepEqual(error.body, { message: "permission denied" });
      return true;
    }
  );
});
