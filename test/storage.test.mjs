import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import {
  DEFAULT_BUCKET,
  StorageError,
  facilityScopedPath,
  signedUploadUrl,
  signedDownloadUrl
} from "../src/lib/storage/storage.mjs";

function withFetch(t, implementation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("DEFAULT_BUCKET is attachments", () => {
  assert.equal(DEFAULT_BUCKET, "attachments");
});

test("facilityScopedPath builds a facility/entity/entityId/filename path", () => {
  const path = facilityScopedPath("fac-1", "incidents", "inc-9", "photo.jpg");
  assert.equal(path, "fac-1/incidents/inc-9/photo.jpg");
});

test("facilityScopedPath sanitizes directory separators out of the filename", () => {
  const path = facilityScopedPath("fac-1", "reports", "sub-1", "../../etc/passwd");
  assert.equal(path, "fac-1/reports/sub-1/passwd");
});

test("facilityScopedPath sanitizes disallowed characters and collapses runs of dashes", () => {
  const path = facilityScopedPath("fac-1", "reports", "sub-1", "Site  Map (final)!!.pdf");
  assert.equal(path, "fac-1/reports/sub-1/Site-Map-final-.pdf");
});

test("facilityScopedPath is deterministic for the same inputs", () => {
  const first = facilityScopedPath("fac-1", "work-orders", "wo-1", "invoice.pdf");
  const second = facilityScopedPath("fac-1", "work-orders", "wo-1", "invoice.pdf");
  assert.equal(first, second);
});

test("facilityScopedPath falls back to 'file' when the filename sanitizes to empty", () => {
  const path = facilityScopedPath("fac-1", "reports", "sub-1", "***");
  assert.equal(path, "fac-1/reports/sub-1/file");
});

test("facilityScopedPath requires facilityId, entity, and entityId", () => {
  assert.throws(() => facilityScopedPath(null, "reports", "sub-1", "a.png"));
  assert.throws(() => facilityScopedPath("fac-1", null, "sub-1", "a.png"));
  assert.throws(() => facilityScopedPath("fac-1", "reports", null, "a.png"));
});

test("signedUploadUrl POSTs to the storage upload-sign endpoint and returns url/token", async (t) => {
  let capturedUrl;
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, text: async () => JSON.stringify({ url: "/signed/upload", token: "tok-1" }) };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const result = await signedUploadUrl(client, { path: "fac-1/reports/sub-1/a.pdf" });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.pathname, "/storage/v1/object/upload/sign/attachments/fac-1/reports/sub-1/a.pdf");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers.apikey, "service-key");
  assert.equal(capturedInit.headers.Authorization, "Bearer service-key");
  assert.equal(result.bucket, "attachments");
  assert.equal(result.path, "fac-1/reports/sub-1/a.pdf");
  assert.equal(result.url, "/signed/upload");
  assert.equal(result.token, "tok-1");
});

test("signedUploadUrl encodes each path segment and honors a custom bucket", async (t) => {
  let capturedUrl;
  withFetch(t, async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, text: async () => JSON.stringify({ url: "/x", token: "y" }) };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  await signedUploadUrl(client, { bucket: "custom-bucket", path: "fac 1/reports/sub-1/a b.pdf" });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.pathname, "/storage/v1/object/upload/sign/custom-bucket/fac%201/reports/sub-1/a%20b.pdf");
});

test("signedUploadUrl requires a path", async () => {
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  await assert.rejects(() => signedUploadUrl(client, {}));
});

test("signedDownloadUrl POSTs to the storage sign endpoint with expiresIn", async (t) => {
  let capturedUrl;
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, text: async () => JSON.stringify({ signedURL: "/signed/download?token=z" }) };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const result = await signedDownloadUrl(client, { path: "fac-1/incidents/inc-1/photo.jpg", expiresIn: 120 });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.pathname, "/storage/v1/object/sign/attachments/fac-1/incidents/inc-1/photo.jpg");
  assert.equal(capturedInit.method, "POST");
  assert.deepEqual(JSON.parse(capturedInit.body), { expiresIn: 120 });
  assert.equal(result.url, "/signed/download?token=z");
  assert.equal(result.expiresIn, 120);
});

test("signedDownloadUrl defaults expiresIn to 3600 seconds", async (t) => {
  let capturedInit;
  withFetch(t, async (url, init) => {
    capturedInit = init;
    return { ok: true, status: 200, text: async () => JSON.stringify({ signedURL: "/signed" }) };
  });

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const result = await signedDownloadUrl(client, { path: "fac-1/reports/sub-1/a.pdf" });
  assert.deepEqual(JSON.parse(capturedInit.body), { expiresIn: 3600 });
  assert.equal(result.expiresIn, 3600);
});

test("signedDownloadUrl requires a path", async () => {
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  await assert.rejects(() => signedDownloadUrl(client, {}));
});

test("non-2xx storage responses throw a StorageError with status and body", async (t) => {
  withFetch(t, async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ message: "not found" })
  }));

  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  await assert.rejects(
    () => signedDownloadUrl(client, { path: "fac-1/reports/sub-1/missing.pdf" }),
    (error) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.status, 404);
      assert.deepEqual(error.body, { message: "not found" });
      return true;
    }
  );
});
