import test from "node:test";
import assert from "node:assert/strict";
import {
  createStorageClient,
  createStorageClientFromEnv,
  buildAttachmentPath,
  assertPathInFacility,
  sanitizeFilename,
  assertMimeAllowed,
  assertWithinSizeCap,
  assertUploadAllowed,
  uploadObject,
  createSignedUrl,
  deleteObject,
  StorageValidationError,
  StorageRequestError,
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES
} from "../src/lib/storage.mjs";

const FACILITY_ID = "11111111-1111-1111-1111-111111111111";
const RECORD_ID = "22222222-2222-2222-2222-222222222222";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stubClient(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const result = respond(calls[calls.length - 1]) ?? { status: 200, body: {} };
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => (result.body === undefined ? "" : JSON.stringify(result.body))
    };
  };
  const client = createStorageClient({
    url: "https://example.supabase.co",
    key: "service-role-key",
    bucket: "attachments",
    fetchImpl
  });
  return { client, calls };
}

// --- createStorageClient / createStorageClientFromEnv -----------------------

test("createStorageClient requires a url, key, and bucket", () => {
  assert.throws(() => createStorageClient({ key: "k", bucket: "b" }));
  assert.throws(() => createStorageClient({ url: "https://example.supabase.co", bucket: "b" }));
  assert.throws(() => createStorageClient({ url: "https://example.supabase.co", key: "k", bucket: "" }));
});

test("createStorageClient defaults the bucket to attachments and strips a trailing slash from the url", () => {
  const client = createStorageClient({ url: "https://example.supabase.co/", key: "k" });
  assert.equal(client.bucket, "attachments");
  assert.equal(client.url, "https://example.supabase.co");
});

test("createStorageClientFromEnv builds a client from the server env, defaulting the bucket", () => {
  const client = createStorageClientFromEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key"
  });
  assert.equal(client.bucket, "attachments");
  assert.equal(client.key, "service-key");
});

test("createStorageClientFromEnv honors an explicit SUPABASE_STORAGE_BUCKET", () => {
  const client = createStorageClientFromEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUPABASE_STORAGE_BUCKET: "custom-bucket"
  });
  assert.equal(client.bucket, "custom-bucket");
});

test("createStorageClientFromEnv requires a service role key", () => {
  assert.throws(() => createStorageClientFromEnv({ SUPABASE_URL: "https://example.supabase.co" }));
});

// --- buildAttachmentPath / sanitizeFilename: path safety --------------------

test("buildAttachmentPath produces the facilities/{facilityId}/{module}/{recordId}/{uuid}-{safeName} shape", () => {
  const path = buildAttachmentPath(FACILITY_ID, "incidents", RECORD_ID, "photo.jpg");
  const parts = path.split("/");
  assert.equal(parts.length, 5);
  assert.equal(parts[0], "facilities");
  assert.equal(parts[1], FACILITY_ID);
  assert.equal(parts[2], "incidents");
  assert.equal(parts[3], RECORD_ID);
  const [uuidPrefix, ...rest] = parts[4].split("-");
  // the uuid itself contains hyphens, so re-split on the first 5 hyphenated
  // groups instead of assuming a single "-" separates uuid from filename
  const match = parts[4].match(/^([0-9a-f-]{36})-(.+)$/i);
  assert.ok(match, `expected a uuid-prefixed filename, got ${parts[4]}`);
  assert.match(match[1], UUID_RE);
  assert.equal(match[2], "photo.jpg");
});

test("buildAttachmentPath prepends a fresh, unique uuid on every call", () => {
  const first = buildAttachmentPath(FACILITY_ID, "incidents", RECORD_ID, "photo.jpg");
  const second = buildAttachmentPath(FACILITY_ID, "incidents", RECORD_ID, "photo.jpg");
  assert.notEqual(first, second);
  const firstUuid = first.split("/")[4].match(/^([0-9a-f-]{36})-/i)[1];
  const secondUuid = second.split("/")[4].match(/^([0-9a-f-]{36})-/i)[1];
  assert.notEqual(firstUuid, secondUuid);
  assert.match(firstUuid, UUID_RE);
  assert.match(secondUuid, UUID_RE);
});

test("buildAttachmentPath rejects a non-uuid facilityId", () => {
  assert.throws(
    () => buildAttachmentPath("not-a-uuid", "incidents", RECORD_ID, "photo.jpg"),
    StorageValidationError
  );
});

test("buildAttachmentPath rejects a module or recordId containing path separators", () => {
  assert.throws(() => buildAttachmentPath(FACILITY_ID, "../etc", RECORD_ID, "photo.jpg"), StorageValidationError);
  assert.throws(() => buildAttachmentPath(FACILITY_ID, "incidents", "../../secrets", "photo.jpg"), StorageValidationError);
  assert.throws(() => buildAttachmentPath(FACILITY_ID, "incidents/nested", RECORD_ID, "photo.jpg"), StorageValidationError);
});

// --- assertPathInFacility -----------------------------------------------

test("assertPathInFacility accepts a path under the given facility and module, and returns it", () => {
  const path = `facilities/${FACILITY_ID}/incidents/${RECORD_ID}/uuid-photo.jpg`;
  assert.equal(assertPathInFacility(path, FACILITY_ID, "incidents"), path);
});

test("assertPathInFacility rejects a path naming a different facility (path_outside_facility)", () => {
  const otherFacilityId = "99999999-9999-9999-9999-999999999999";
  const path = `facilities/${otherFacilityId}/incidents/${RECORD_ID}/uuid-photo.jpg`;
  assert.throws(
    () => assertPathInFacility(path, FACILITY_ID, "incidents"),
    (error) => error instanceof StorageValidationError && error.code === "path_outside_facility"
  );
});

test("assertPathInFacility rejects a path under the right facility but a different module", () => {
  const path = `facilities/${FACILITY_ID}/reports/${RECORD_ID}/uuid-photo.jpg`;
  assert.throws(
    () => assertPathInFacility(path, FACILITY_ID, "incidents"),
    (error) => error instanceof StorageValidationError && error.code === "path_outside_facility"
  );
});

test("assertPathInFacility rejects a facility-id-as-prefix path that isn't actually scoped to it (no false positive on string prefix)", () => {
  // "11111111-1111-1111-1111-111111111111X" starts with FACILITY_ID as a raw
  // string but is not the same facility segment -- assertPathInFacility must
  // require the "/" boundary, not just String.startsWith on the facilityId
  // alone.
  const path = `facilities/${FACILITY_ID}X/incidents/${RECORD_ID}/uuid-photo.jpg`;
  assert.throws(
    () => assertPathInFacility(path, FACILITY_ID, "incidents"),
    (error) => error instanceof StorageValidationError && error.code === "path_outside_facility"
  );
});

test("assertPathInFacility rejects a non-uuid facilityId before even looking at the path", () => {
  assert.throws(
    () => assertPathInFacility(`facilities/not-a-uuid/incidents/${RECORD_ID}/uuid-photo.jpg`, "not-a-uuid", "incidents"),
    StorageValidationError
  );
});

test("assertPathInFacility rejects a null/undefined/non-string path", () => {
  assert.throws(() => assertPathInFacility(null, FACILITY_ID, "incidents"), StorageValidationError);
  assert.throws(() => assertPathInFacility(undefined, FACILITY_ID, "incidents"), StorageValidationError);
});

test("sanitizeFilename rejects traversal attempts outright rather than cleaning them", () => {
  assert.throws(() => sanitizeFilename("../../etc/passwd"), StorageValidationError);
  assert.throws(() => sanitizeFilename("a/../b.png"), StorageValidationError);
  assert.throws(() => sanitizeFilename("dir/photo.jpg"), StorageValidationError);
  assert.throws(() => sanitizeFilename("dir\\photo.jpg"), StorageValidationError);
  assert.throws(() => sanitizeFilename("..\\photo.jpg"), StorageValidationError);
});

test("sanitizeFilename rejects null bytes and other control characters", () => {
  const nullByteName = `photo${String.fromCharCode(0)}.jpg`;
  const bellCharName = `photo${String.fromCharCode(7)}.jpg`;
  assert.throws(() => sanitizeFilename(nullByteName), StorageValidationError);
  assert.throws(() => sanitizeFilename(bellCharName), StorageValidationError);
});

test("sanitizeFilename rejects empty, dot-only, or blank filenames", () => {
  assert.throws(() => sanitizeFilename(""), StorageValidationError);
  assert.throws(() => sanitizeFilename("."), StorageValidationError);
  assert.throws(() => sanitizeFilename("   "), StorageValidationError);
  assert.throws(() => sanitizeFilename(undefined), StorageValidationError);
});

test("sanitizeFilename folds odd-but-not-dangerous characters into a safe charset instead of throwing", () => {
  assert.equal(sanitizeFilename("My Photo (final)!.jpg"), "My-Photo-final-.jpg");
  assert.equal(sanitizeFilename("café menu.pdf"), "caf-menu.pdf");
  assert.equal(sanitizeFilename("###.png"), "png");
});

test("sanitizeFilename collapses repeated separators and trims stray leading/trailing punctuation", () => {
  assert.equal(sanitizeFilename("weird***name.jpg"), "weird-name.jpg");
  assert.equal(sanitizeFilename("---leading-and-trailing---"), "leading-and-trailing");
});

test("sanitizeFilename truncates very long names while preserving a short extension", () => {
  const longName = `${"a".repeat(300)}.png`;
  const result = sanitizeFilename(longName);
  assert.ok(result.length <= 180);
  assert.ok(result.endsWith(".png"));
});

// --- mime allow-list + size cap ---------------------------------------------

test("assertMimeAllowed accepts every default-allowed type and ignores a charset parameter", () => {
  for (const type of DEFAULT_ALLOWED_MIME_TYPES) {
    assert.doesNotThrow(() => assertMimeAllowed(type));
  }
  assert.doesNotThrow(() => assertMimeAllowed("image/png; charset=binary"));
});

test("assertMimeAllowed rejects a type outside the default allow-list", () => {
  assert.throws(() => assertMimeAllowed("application/x-msdownload"), StorageValidationError);
  assert.throws(() => assertMimeAllowed("text/html"), StorageValidationError);
  assert.throws(() => assertMimeAllowed(undefined), StorageValidationError);
  assert.throws(() => assertMimeAllowed(""), StorageValidationError);
});

test("assertMimeAllowed honors a custom allow-list override", () => {
  assert.doesNotThrow(() => assertMimeAllowed("video/mp4", ["video/mp4"]));
  assert.throws(() => assertMimeAllowed("image/png", ["video/mp4"]), StorageValidationError);
});

test("assertWithinSizeCap accepts sizes at or under the default 4 MB cap", () => {
  assert.doesNotThrow(() => assertWithinSizeCap(0));
  assert.doesNotThrow(() => assertWithinSizeCap(DEFAULT_MAX_UPLOAD_BYTES));
});

test("assertWithinSizeCap rejects sizes over the default cap", () => {
  assert.throws(() => assertWithinSizeCap(DEFAULT_MAX_UPLOAD_BYTES + 1), StorageValidationError);
});

test("assertWithinSizeCap honors a custom maxBytes override", () => {
  assert.doesNotThrow(() => assertWithinSizeCap(1024, 2048));
  assert.throws(() => assertWithinSizeCap(2049, 2048), StorageValidationError);
});

test("assertWithinSizeCap rejects non-numeric or negative sizes", () => {
  assert.throws(() => assertWithinSizeCap(-1), StorageValidationError);
  assert.throws(() => assertWithinSizeCap("4000000"), StorageValidationError);
  assert.throws(() => assertWithinSizeCap(Number.NaN), StorageValidationError);
});

test("assertUploadAllowed runs the mime check before the size check", () => {
  assert.throws(
    () => assertUploadAllowed({ contentType: "text/html", size: 10 }),
    (error) => error instanceof StorageValidationError && error.code === "mime_not_allowed"
  );
  assert.throws(
    () => assertUploadAllowed({ contentType: "image/png", size: DEFAULT_MAX_UPLOAD_BYTES + 1 }),
    (error) => error instanceof StorageValidationError && error.code === "file_too_large"
  );
  assert.doesNotThrow(() => assertUploadAllowed({ contentType: "application/pdf", size: 1024 }));
});

// --- uploadObject: stubbed REST calls ---------------------------------------

test("uploadObject POSTs to the bucket/path with content-type and apikey/auth headers", async () => {
  const { client, calls } = stubClient(() => ({ status: 200, body: { Key: "attachments/facilities/x" } }));
  const path = `facilities/${FACILITY_ID}/incidents/${RECORD_ID}/aaaa-photo.jpg`;
  const result = await uploadObject(client, { path, body: Buffer.from("bytes"), contentType: "image/jpeg" });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.pathname, `/storage/v1/object/attachments/${path}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, "service-role-key");
  assert.equal(init.headers.Authorization, "Bearer service-role-key");
  assert.equal(init.headers["Content-Type"], "image/jpeg");
  assert.equal(init.headers["x-upsert"], "false");
  assert.deepEqual(result, { Key: "attachments/facilities/x" });
});

test("uploadObject sets x-upsert true when upsert is requested", async () => {
  const { client, calls } = stubClient(() => ({ status: 200, body: {} }));
  await uploadObject(client, {
    path: "facilities/x/incidents/y/id-name.jpg",
    body: "bytes",
    contentType: "image/jpeg",
    upsert: true
  });
  assert.equal(calls[0].init.headers["x-upsert"], "true");
});

test("uploadObject requires a path and a body", async () => {
  const { client } = stubClient(() => ({ status: 200, body: {} }));
  await assert.rejects(() => uploadObject(client, { body: "x", contentType: "image/jpeg" }), StorageValidationError);
  await assert.rejects(() => uploadObject(client, { path: "p", contentType: "image/jpeg" }), StorageValidationError);
});

test("uploadObject throws StorageRequestError with status and body on a non-2xx response", async () => {
  const { client } = stubClient(() => ({ status: 400, body: { message: "bad request" } }));
  await assert.rejects(
    () => uploadObject(client, { path: "facilities/x/incidents/y/id-name.jpg", body: "x", contentType: "image/jpeg" }),
    (error) => {
      assert.ok(error instanceof StorageRequestError);
      assert.equal(error.status, 400);
      assert.deepEqual(error.body, { message: "bad request" });
      return true;
    }
  );
});

// --- createSignedUrl: request shape + ttl -----------------------------------

test("createSignedUrl POSTs to object/sign/{bucket}/{path} with { expiresIn } and returns the full URL", async () => {
  const { client, calls } = stubClient(() => ({ status: 200, body: { signedURL: "/object/sign/attachments/p?token=abc" } }));
  const path = "facilities/x/incidents/y/id-name.jpg";
  const url = await createSignedUrl(client, path, 300);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, `/storage/v1/object/sign/attachments/${path}`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { expiresIn: 300 });
  assert.equal(url, "https://example.supabase.co/storage/v1/object/sign/attachments/p?token=abc");
});

test("createSignedUrl rejects a zero, negative, or non-integer ttl without calling fetch", async () => {
  const { client, calls } = stubClient(() => ({ status: 200, body: { signedURL: "/x" } }));
  await assert.rejects(() => createSignedUrl(client, "p", 0), StorageValidationError);
  await assert.rejects(() => createSignedUrl(client, "p", -5), StorageValidationError);
  await assert.rejects(() => createSignedUrl(client, "p", 5.5), StorageValidationError);
  await assert.rejects(() => createSignedUrl(client, "p", "60"), StorageValidationError);
  assert.equal(calls.length, 0);
});

test("createSignedUrl throws a StorageRequestError when the response has no signedURL", async () => {
  const { client } = stubClient(() => ({ status: 200, body: {} }));
  await assert.rejects(() => createSignedUrl(client, "p", 60), StorageRequestError);
});

// --- deleteObject: stubbed REST calls ---------------------------------------

test("deleteObject DELETEs object/{bucket} with { prefixes: [path] }", async () => {
  const { client, calls } = stubClient(() => ({ status: 200, body: [{ name: "p" }] }));
  const path = "facilities/x/incidents/y/id-name.jpg";
  const result = await deleteObject(client, path);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/storage/v1/object/attachments");
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[0].init.body), { prefixes: [path] });
  assert.deepEqual(result, [{ name: "p" }]);
});

test("deleteObject requires a path", async () => {
  const { client } = stubClient(() => ({ status: 200, body: [] }));
  await assert.rejects(() => deleteObject(client, ""), StorageValidationError);
});

test("deleteObject throws StorageRequestError with status and body on a non-2xx response", async () => {
  const { client } = stubClient(() => ({ status: 404, body: { message: "not found" } }));
  await assert.rejects(
    () => deleteObject(client, "facilities/x/incidents/y/id-name.jpg"),
    (error) => {
      assert.ok(error instanceof StorageRequestError);
      assert.equal(error.status, 404);
      assert.deepEqual(error.body, { message: "not found" });
      return true;
    }
  );
});
