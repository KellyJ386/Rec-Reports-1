import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerAttachmentRoutes } from "../src/lib/http/attachments-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const REPORT_CREATOR = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read", "reports.create"] }];
const REPORT_READER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const INCIDENT_MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.manage"] }
];
const INCIDENT_READER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];
const WORK_ORDER_MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["work_orders.read", "work_orders.manage"] }
];
const WORK_ORDER_READER = [{ facilityId: "fac-1", status: "active", permissions: ["work_orders.read"] }];
const OUTSIDER = [
  {
    facilityId: "fac-2",
    status: "active",
    permissions: ["reports.read", "reports.create", "incidents.read", "incidents.manage", "work_orders.read", "work_orders.manage"]
  }
];

// Distinguishes PostgREST (/rest/v1/<table>) calls from Supabase Storage
// (/storage/v1/object/(upload/)sign/<bucket>/<path>) calls so a single
// respond() callback can stub both, keyed by a stable "kind" + "key".
function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method;
    let kind;
    let key;
    if (parsed.pathname.startsWith("/rest/v1/")) {
      kind = "rest";
      key = parsed.pathname.replace("/rest/v1/", "");
    } else if (parsed.pathname.startsWith("/storage/v1/object/upload/sign/")) {
      kind = "upload-sign";
      key = parsed.pathname.replace("/storage/v1/object/upload/sign/", "");
    } else if (parsed.pathname.startsWith("/storage/v1/object/sign/")) {
      kind = "download-sign";
      key = parsed.pathname.replace("/storage/v1/object/sign/", "");
    } else {
      kind = "unknown";
      key = parsed.pathname;
    }
    const entry = { kind, key, method, url: parsed, body: init.body ? JSON.parse(init.body) : null };
    captured.push(entry);
    const data = respond(entry) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function mount({ memberships = REPORT_CREATOR, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerAttachmentRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

// --- Report submission attachments -----------------------------------------

test("POST reports attachments/sign denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/attachments/sign", {
    filename: "photo.jpg",
    mimeType: "image/jpeg"
  });
  assert.equal(result.status, 403);
});

test("POST reports attachments/sign validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: REPORT_READER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/attachments/sign", { filename: "" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST reports attachments/sign happy path returns a signed upload url and computed path", async (t) => {
  const captured = stubFetch(t, (entry) =>
    entry.kind === "upload-sign" ? { url: "/upload-target", token: "tok-1" } : []
  );
  const { call } = mount({ memberships: REPORT_CREATOR });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/attachments/sign", {
    filename: "shift-log.pdf",
    mimeType: "application/pdf"
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.path, "fac-1/reports/sub-1/shift-log.pdf");
  assert.equal(result.payload.uploadUrl, "/upload-target");
  assert.equal(result.payload.token, "tok-1");
  const sign = captured.find((c) => c.kind === "upload-sign");
  assert.equal(sign.key, "attachments/fac-1/reports/sub-1/shift-log.pdf");
});

test("POST reports attachments validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: REPORT_READER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/attachments", { mimeType: "application/pdf" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST reports attachments denies a reader without reports.create", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: REPORT_READER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/attachments", {
    fieldKey: "opening-photo",
    storagePath: "fac-1/reports/sub-1/shift-log.pdf",
    mimeType: "application/pdf"
  });
  assert.equal(result.status, 403);
});

test("POST reports attachments happy path records the attachment row", async (t) => {
  const captured = stubFetch(t, (entry) =>
    entry.kind === "rest" && entry.key === "report_submission_attachments" && entry.method === "POST"
      ? [{ id: "att-1" }]
      : []
  );
  const { call } = mount({ memberships: REPORT_CREATOR, userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/attachments", {
    fieldKey: "opening-photo",
    storagePath: "fac-1/reports/sub-1/shift-log.pdf",
    mimeType: "application/pdf",
    checksum: "abc123"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.kind === "rest" && c.key === "report_submission_attachments");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].submission_id, "sub-1");
  assert.equal(insert.body[0].field_key, "opening-photo");
  assert.equal(insert.body[0].storage_path, "fac-1/reports/sub-1/shift-log.pdf");
  assert.equal(insert.body[0].mime_type, "application/pdf");
  assert.equal(insert.body[0].checksum, "abc123");
});

test("GET report-attachments/:id/download 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: REPORT_READER });
  const result = await call("GET", "/report-attachments/att-1/download");
  assert.equal(result.status, 404);
});

test("GET report-attachments/:id/download requires reports.read and returns a signed url", async (t) => {
  stubFetch(t, (entry) => {
    if (entry.kind === "rest" && entry.key === "report_submission_attachments") {
      return [{ id: "att-1", facility_id: "fac-1", storage_path: "fac-1/reports/sub-1/shift-log.pdf" }];
    }
    if (entry.kind === "download-sign") return { signedURL: "/download-target" };
    return [];
  });
  const { call } = mount({ memberships: REPORT_READER });
  const result = await call("GET", "/report-attachments/att-1/download");
  assert.equal(result.status, 200);
  assert.equal(result.payload.url, "/download-target");
});

test("GET report-attachments/:id/download denies a non-member of the row's facility", async (t) => {
  stubFetch(t, (entry) =>
    entry.kind === "rest" && entry.key === "report_submission_attachments"
      ? [{ id: "att-1", facility_id: "fac-1", storage_path: "fac-1/reports/sub-1/shift-log.pdf" }]
      : []
  );
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/report-attachments/att-1/download");
  assert.equal(result.status, 403);
});

// --- Incident attachments ----------------------------------------------------

test("POST incidents attachments/sign denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/attachments/sign", {
    filename: "photo.jpg",
    mimeType: "image/jpeg"
  });
  assert.equal(result.status, 403);
});

test("POST incidents attachments/sign validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/attachments/sign", { mimeType: "image/jpeg" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST incidents attachments/sign happy path returns a signed upload url and computed path", async (t) => {
  const captured = stubFetch(t, (entry) =>
    entry.kind === "upload-sign" ? { url: "/upload-target", token: "tok-2" } : []
  );
  const { call } = mount({ memberships: INCIDENT_MANAGER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/attachments/sign", {
    filename: "scene.jpg",
    mimeType: "image/jpeg"
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.path, "fac-1/incidents/inc-1/scene.jpg");
  const sign = captured.find((c) => c.kind === "upload-sign");
  assert.equal(sign.key, "attachments/fac-1/incidents/inc-1/scene.jpg");
});

test("POST incidents attachments rejects an invalid attachmentType before guarding", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/attachments", {
    attachmentType: "tweet",
    storagePath: "fac-1/incidents/inc-1/scene.jpg"
  });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST incidents attachments denies a reader without incidents.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_READER });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/attachments", {
    attachmentType: "photo",
    storagePath: "fac-1/incidents/inc-1/scene.jpg"
  });
  assert.equal(result.status, 403);
});

test("POST incidents attachments happy path records the attachment row and stamps captured_by", async (t) => {
  const captured = stubFetch(t, (entry) =>
    entry.kind === "rest" && entry.key === "incident_attachments" && entry.method === "POST" ? [{ id: "att-2" }] : []
  );
  const { call } = mount({ memberships: INCIDENT_MANAGER, userId: "user-7" });
  const result = await call("POST", "/facilities/fac-1/incidents/inc-1/attachments", {
    attachmentType: "photo",
    storagePath: "fac-1/incidents/inc-1/scene.jpg",
    checksum: "sha-1"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.kind === "rest" && c.key === "incident_attachments");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].incident_id, "inc-1");
  assert.equal(insert.body[0].attachment_type, "photo");
  assert.equal(insert.body[0].storage_path, "fac-1/incidents/inc-1/scene.jpg");
  assert.equal(insert.body[0].captured_by, "user-7");
  assert.equal(insert.body[0].checksum_sha256, "sha-1");
});

test("GET incident-attachments/:id/download 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: INCIDENT_READER });
  const result = await call("GET", "/incident-attachments/att-2/download");
  assert.equal(result.status, 404);
});

test("GET incident-attachments/:id/download requires incidents.read and returns a signed url", async (t) => {
  stubFetch(t, (entry) => {
    if (entry.kind === "rest" && entry.key === "incident_attachments") {
      return [{ id: "att-2", facility_id: "fac-1", storage_path: "fac-1/incidents/inc-1/scene.jpg" }];
    }
    if (entry.kind === "download-sign") return { signedURL: "/download-target-2" };
    return [];
  });
  const { call } = mount({ memberships: INCIDENT_READER });
  const result = await call("GET", "/incident-attachments/att-2/download");
  assert.equal(result.status, 200);
  assert.equal(result.payload.url, "/download-target-2");
});

// --- Work order attachments ---------------------------------------------------

test("POST work-orders attachments/sign denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("POST", "/facilities/fac-1/work-orders/wo-1/attachments/sign", {
    filename: "invoice.pdf",
    mimeType: "application/pdf"
  });
  assert.equal(result.status, 403);
});

test("POST work-orders attachments/sign validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: WORK_ORDER_READER });
  const result = await call("POST", "/facilities/fac-1/work-orders/wo-1/attachments/sign", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST work-orders attachments/sign happy path returns a signed upload url and computed path", async (t) => {
  const captured = stubFetch(t, (entry) =>
    entry.kind === "upload-sign" ? { url: "/upload-target-3", token: "tok-3" } : []
  );
  const { call } = mount({ memberships: WORK_ORDER_MANAGER });
  const result = await call("POST", "/facilities/fac-1/work-orders/wo-1/attachments/sign", {
    filename: "invoice.pdf",
    mimeType: "application/pdf"
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.path, "fac-1/work-orders/wo-1/invoice.pdf");
  const sign = captured.find((c) => c.kind === "upload-sign");
  assert.equal(sign.key, "attachments/fac-1/work-orders/wo-1/invoice.pdf");
});

test("POST work-orders attachments denies a reader without work_orders.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: WORK_ORDER_READER });
  const result = await call("POST", "/facilities/fac-1/work-orders/wo-1/attachments", {
    storagePath: "fac-1/work-orders/wo-1/invoice.pdf",
    mimeType: "application/pdf"
  });
  assert.equal(result.status, 403);
});

test("POST work-orders attachments happy path records the attachment row and stamps created_by", async (t) => {
  const captured = stubFetch(t, (entry) =>
    entry.kind === "rest" && entry.key === "work_order_attachments" && entry.method === "POST"
      ? [{ id: "att-3" }]
      : []
  );
  const { call } = mount({ memberships: WORK_ORDER_MANAGER, userId: "user-4" });
  const result = await call("POST", "/facilities/fac-1/work-orders/wo-1/attachments", {
    storagePath: "fac-1/work-orders/wo-1/invoice.pdf",
    mimeType: "application/pdf"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.kind === "rest" && c.key === "work_order_attachments");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].work_order_id, "wo-1");
  assert.equal(insert.body[0].storage_path, "fac-1/work-orders/wo-1/invoice.pdf");
  assert.equal(insert.body[0].mime_type, "application/pdf");
  assert.equal(insert.body[0].created_by, "user-4");
});

test("GET work-order-attachments/:id/download 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: WORK_ORDER_READER });
  const result = await call("GET", "/work-order-attachments/att-3/download");
  assert.equal(result.status, 404);
});

test("GET work-order-attachments/:id/download requires work_orders.read and returns a signed url", async (t) => {
  stubFetch(t, (entry) => {
    if (entry.kind === "rest" && entry.key === "work_order_attachments") {
      return [{ id: "att-3", facility_id: "fac-1", storage_path: "fac-1/work-orders/wo-1/invoice.pdf" }];
    }
    if (entry.kind === "download-sign") return { signedURL: "/download-target-3" };
    return [];
  });
  const { call } = mount({ memberships: WORK_ORDER_READER });
  const result = await call("GET", "/work-order-attachments/att-3/download");
  assert.equal(result.status, 200);
  assert.equal(result.payload.url, "/download-target-3");
});
