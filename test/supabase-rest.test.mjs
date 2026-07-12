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
