import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAttachmentRoutes } from "../src/lib/http/attachments-routes.mjs";
import { createClient as createDbClient } from "../src/lib/supabase-rest.mjs";
import { createStorageClient, DEFAULT_MAX_UPLOAD_BYTES } from "../src/lib/storage.mjs";

// --- Postgrest stub (mirrors test/work-orders-routes.test.mjs) -------------

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    captured.push({ table, method, url: parsed, body: init.body ? JSON.parse(init.body) : null });
    const data = respond(table, method, parsed) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

// --- Storage REST stub -------------------------------------------------

function stubStorageClient(t, { failUpload = false, failSign = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, method: init.method, headers: init.headers, body: init.body });
    if (parsed.pathname.includes("/object/sign/")) {
      if (failSign) return { ok: false, status: 500, text: async () => "" };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ signedURL: "/object/sign/attachments/signed-token?token=abc" })
      };
    }
    if (failUpload) return { ok: false, status: 500, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ Key: "attachments/whatever" }) };
  };
  const client = createStorageClient({ url: "https://storage.example.co", key: "svc-key", fetchImpl });
  return { client, calls };
}

// --- Fake raw-body request (mirrors test/read-body-limit.test.mjs) --------

function makeUploadRequest(headers = {}) {
  const request = new EventEmitter();
  request.headers = headers;
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  return request;
}

async function waitForListener(emitter, event) {
  while (emitter.listenerCount(event) === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// --- Harness -----------------------------------------------------------

function mount({ memberships, userId = "user-1", createStorageClient: injectStorageClient } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createDbClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  registerAttachmentRoutes(router, { authenticate, sendJson, createStorageClient: injectStorageClient });

  async function call(method, path) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    await handler({ headers: {} }, {}, { env: {}, params });
    return sent[sent.length - 1];
  }

  // Drives a POST upload route: sets up listeners via handler, then streams
  // `body` (if provided) through the request once readRawBody has attached
  // its 'data' listener -- routes that reject before ever reading the body
  // (bad mime, missing filename, oversize Content-Length, permission/404/409
  // denials) resolve without us ever needing to emit anything.
  async function callUpload(method, path, { headers = {}, body } = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = makeUploadRequest(headers);
    const pending = handler(request, {}, { env: {}, params });
    if (body !== undefined) {
      await waitForListener(request, "data");
      request.emit("data", body);
      request.emit("end");
    }
    await pending;
    return sent[sent.length - 1];
  }

  return { call, callUpload, sent };
}

// --- Module fixtures -----------------------------------------------------

const FAC_1 = "11111111-1111-1111-1111-111111111111";
const FAC_2 = "22222222-2222-2222-2222-222222222222";

const MODULES = [
  {
    name: "reports",
    urlSegment: "reports",
    parentTable: "report_submissions",
    parentLabel: "report",
    readPerm: "reports.read",
    writePerm: "reports.submit",
    attachmentTable: "report_submission_attachments",
    parentColumn: "submission_id",
    checksumColumn: "checksum",
    parent: (overrides) => ({ id: "rep-1", facility_id: FAC_1, status: "draft", ...overrides })
  },
  {
    name: "incidents",
    urlSegment: "incidents",
    parentTable: "incident_reports",
    parentLabel: "incident",
    readPerm: "incidents.read",
    writePerm: "incidents.manage",
    attachmentTable: "incident_attachments",
    parentColumn: "incident_id",
    checksumColumn: "checksum_sha256",
    parent: (overrides) => ({ id: "inc-1", facility_id: FAC_1, status: "open", ...overrides })
  },
  {
    name: "work-orders",
    urlSegment: "work-orders",
    parentTable: "work_orders",
    parentLabel: "work order",
    readPerm: "work_orders.read",
    writePerm: "work_orders.manage",
    attachmentTable: "work_order_attachments",
    parentColumn: "work_order_id",
    checksumColumn: "checksum",
    parent: (overrides) => ({ id: "wo-1", facility_id: FAC_1, status: "open", ...overrides })
  }
];

function membershipsFor(facilityId, permissions) {
  return [{ facilityId, status: "active", permissions }];
}

for (const mod of MODULES) {
  const READER = membershipsFor(FAC_1, [mod.readPerm]);
  const WRITER = membershipsFor(FAC_1, [mod.readPerm, mod.writePerm]);
  const OUTSIDER = membershipsFor(FAC_2, [mod.readPerm, mod.writePerm]);

  test(`${mod.name}: POST attachments happy path inserts a shaped row with a server-derived path and checksum`, async (t) => {
    const parentRow = mod.parent();
    const captured = stubFetch(t, (table, method) => {
      if (table === mod.parentTable && method === "GET") return [parentRow];
      if (table === mod.attachmentTable && method === "POST") return [{ id: "att-1" }];
      return [];
    });
    const storage = stubStorageClient(t);
    const { callUpload } = mount({ memberships: WRITER, createStorageClient: () => storage.client });

    const body = Buffer.from("fake-file-bytes");
    const expectedChecksum = createHash("sha256").update(body).digest("hex");
    const result = await callUpload("POST", `/${mod.urlSegment}/${parentRow.id}/attachments`, {
      headers: { "content-type": "image/png", "x-file-name": "photo.png" },
      body
    });

    assert.equal(result.status, 201);

    const insert = captured.find((c) => c.table === mod.attachmentTable && c.method === "POST");
    assert.ok(insert, "attachment metadata row should be inserted");
    assert.equal(insert.body[0].facility_id, FAC_1);
    assert.equal(insert.body[0][mod.parentColumn], parentRow.id);
    assert.equal(insert.body[0][mod.checksumColumn], expectedChecksum, "checksum should be server-computed sha256");

    // storage_path is always derived by buildAttachmentPath, never taken
    // from any client-supplied field (there is no such field on this raw
    // binary POST to begin with).
    assert.match(
      insert.body[0].storage_path,
      new RegExp(`^facilities/${FAC_1}/[a-z_]+/${parentRow.id}/[0-9a-f-]{36}-photo\\.png$`)
    );

    const upload = storage.calls.find((c) => c.method === "POST" && !c.url.pathname.includes("/sign/"));
    assert.ok(upload, "storage upload should have been called");
    assert.equal(upload.headers["Content-Type"], "image/png");
  });

  test(`${mod.name}: POST attachments rejects an oversize declared Content-Length with 413 and zero fetches`, async (t) => {
    const captured = stubFetch(t, () => []);
    const storage = stubStorageClient(t);
    const { callUpload } = mount({ memberships: WRITER, createStorageClient: () => storage.client });

    const result = await callUpload("POST", `/${mod.urlSegment}/some-id/attachments`, {
      headers: {
        "content-type": "image/png",
        "x-file-name": "big.png",
        "content-length": String(DEFAULT_MAX_UPLOAD_BYTES + 1)
      }
    });

    assert.equal(result.status, 413);
    assert.equal(captured.length, 0, "should reject before ever loading the parent row");
    assert.equal(storage.calls.length, 0);
  });

  test(`${mod.name}: POST attachments rejects a disallowed mime type with 400 and zero fetches`, async (t) => {
    const captured = stubFetch(t, () => []);
    const { callUpload } = mount({ memberships: WRITER });

    const result = await callUpload("POST", `/${mod.urlSegment}/some-id/attachments`, {
      headers: { "content-type": "text/plain", "x-file-name": "notes.txt" }
    });

    assert.equal(result.status, 400);
    assert.equal(result.payload.code, "mime_not_allowed");
    assert.equal(captured.length, 0);
  });

  test(`${mod.name}: POST attachments denies a cross-facility caller with 403 and never touches storage`, async (t) => {
    const parentRow = mod.parent();
    stubFetch(t, (table, method) => (table === mod.parentTable && method === "GET" ? [parentRow] : []));
    const storage = stubStorageClient(t);
    const { callUpload } = mount({ memberships: OUTSIDER, createStorageClient: () => storage.client });

    const result = await callUpload("POST", `/${mod.urlSegment}/${parentRow.id}/attachments`, {
      headers: { "content-type": "image/png", "x-file-name": "photo.png" }
    });

    assert.equal(result.status, 403);
    assert.equal(storage.calls.length, 0);
  });

  test(`${mod.name}: reader can list attachments but cannot upload`, async (t) => {
    const parentRow = mod.parent();
    const captured = stubFetch(t, (table, method) => {
      if (table === mod.parentTable && method === "GET") return [parentRow];
      if (table === mod.attachmentTable && method === "GET") {
        return [{ id: "att-1", facility_id: FAC_1, [mod.parentColumn]: parentRow.id }];
      }
      return [];
    });
    const { call, callUpload } = mount({ memberships: READER });

    const listResult = await call("GET", `/${mod.urlSegment}/${parentRow.id}/attachments`);
    assert.equal(listResult.status, 200);
    assert.equal(listResult.payload.length, 1);
    const listGet = captured.find((c) => c.table === mod.attachmentTable && c.method === "GET");
    assert.match(listGet.url.search, new RegExp(`${mod.parentColumn}=eq\\.${parentRow.id}`));

    const uploadResult = await callUpload("POST", `/${mod.urlSegment}/${parentRow.id}/attachments`, {
      headers: { "content-type": "image/png", "x-file-name": "photo.png" }
    });
    assert.equal(uploadResult.status, 403);
  });

  test(`${mod.name}: signed-url route 404s (not 403) for a caller who cannot read the attachment's facility`, async (t) => {
    stubFetch(t, (table, method) =>
      table === mod.attachmentTable && method === "GET"
        ? [{ id: "att-1", facility_id: FAC_1, storage_path: `facilities/${FAC_1}/x/y/z-file.png` }]
        : []
    );
    const storage = stubStorageClient(t);
    const { call } = mount({ memberships: OUTSIDER, createStorageClient: () => storage.client });

    const result = await call("GET", `/${mod.urlSegment}/attachments/att-1/url`);
    assert.equal(result.status, 404);
    assert.equal(storage.calls.length, 0, "should never mint a signed url for a denied caller");
  });

  test(`${mod.name}: signed-url route returns a short-TTL url for an authorized reader`, async (t) => {
    stubFetch(t, (table, method) =>
      table === mod.attachmentTable && method === "GET"
        ? [{ id: "att-1", facility_id: FAC_1, storage_path: `facilities/${FAC_1}/x/y/z-file.png` }]
        : []
    );
    const storage = stubStorageClient(t);
    const { call } = mount({ memberships: READER, createStorageClient: () => storage.client });

    const result = await call("GET", `/${mod.urlSegment}/attachments/att-1/url`);
    assert.equal(result.status, 200);
    assert.ok(result.payload.url.startsWith("https://storage.example.co/storage/v1/object/sign/"));
    assert.equal(result.payload.expiresInSeconds, 300);
    assert.ok(result.payload.expiresInSeconds <= 300, "signed url TTL should be short-lived");

    const sign = storage.calls.find((c) => c.url.pathname.includes("/object/sign/"));
    assert.ok(sign, "should have requested a signed url from storage");
    const signBody = JSON.parse(sign.body);
    assert.equal(signBody.expiresIn, 300);
  });

  test(`${mod.name}: signed-url route 404s when the attachment does not exist`, async (t) => {
    stubFetch(t, () => []);
    const { call } = mount({ memberships: READER });
    const result = await call("GET", `/${mod.urlSegment}/attachments/nope/url`);
    assert.equal(result.status, 404);
  });
}

// --- Reports-only: draft-only upload gate (DR-09) -------------------------

test("reports: POST attachments is rejected once the submission has left draft (409, no storage call)", async (t) => {
  const parentRow = { id: "rep-1", facility_id: FAC_1, status: "submitted" };
  const captured = stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET" ? [parentRow] : []
  );
  const storage = stubStorageClient(t);
  const memberships = membershipsFor(FAC_1, ["reports.read", "reports.submit"]);
  const { callUpload } = mount({ memberships, createStorageClient: () => storage.client });

  const result = await callUpload("POST", "/reports/rep-1/attachments", {
    headers: { "content-type": "image/png", "x-file-name": "photo.png" }
  });

  assert.equal(result.status, 409);
  assert.equal(storage.calls.length, 0);
  assert.equal(
    captured.filter((c) => c.table === "report_submission_attachments" && c.method === "POST").length,
    0
  );
});

test("reports: POST attachments succeeds while the submission is still a draft", async (t) => {
  const parentRow = { id: "rep-1", facility_id: FAC_1, status: "draft" };
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [parentRow];
    if (table === "report_submission_attachments" && method === "POST") return [{ id: "att-1" }];
    return [];
  });
  const storage = stubStorageClient(t);
  const memberships = membershipsFor(FAC_1, ["reports.read", "reports.submit"]);
  const { callUpload } = mount({ memberships, createStorageClient: () => storage.client });

  const result = await callUpload("POST", "/reports/rep-1/attachments", {
    headers: { "content-type": "application/pdf", "x-file-name": "evidence.pdf" },
    body: Buffer.from("%PDF-fake")
  });

  assert.equal(result.status, 201);
});

test("reports: a caller with only reports.create (no reports.submit) cannot upload to a draft", async (t) => {
  const parentRow = { id: "rep-1", facility_id: FAC_1, status: "draft" };
  stubFetch(t, (table, method) => (table === "report_submissions" && method === "GET" ? [parentRow] : []));
  const memberships = membershipsFor(FAC_1, ["reports.read", "reports.create"]);
  const { callUpload } = mount({ memberships });

  const result = await callUpload("POST", "/reports/rep-1/attachments", {
    headers: { "content-type": "image/png", "x-file-name": "photo.png" }
  });

  assert.equal(result.status, 403, "attachment upload should be gated like the PATCH draft-edit permission");
});
