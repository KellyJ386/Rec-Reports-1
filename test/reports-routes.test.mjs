import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerReportRoutes, signatureHash } from "../src/lib/http/reports-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const CREATOR = [
  { facilityId: "fac-1", status: "active", permissions: ["reports.read", "reports.create", "reports.submit"] }
];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["reports.read", "reports.create"] }];

const SCHEMA = {
  sections: [
    {
      title: "Opening",
      fields: [
        { key: "supervisor", label: "Supervisor", type: "text", required: true },
        { key: "attendance", label: "Attendance", type: "number", required: true }
      ]
    }
  ]
};

const PUBLISHED_TEMPLATE = {
  id: "tpl-1",
  facility_id: "fac-1",
  department_id: null,
  code: "daily-open",
  name: "Daily Opening",
  status: "published",
  active_version: 3
};
const VERSION = { id: "ver-3", template_id: "tpl-1", version_number: 3, schema_json: SCHEMA, is_published: true };

// DR-11: department-scoped memberships (department_id set) and a
// department-scoped template/submission fixture pair.
const DEPT_A_TEMPLATE = { ...PUBLISHED_TEMPLATE, id: "tpl-dept-a", department_id: "dept-a" };
const DEPT_A_MEMBER = [
  {
    facilityId: "fac-1",
    status: "active",
    departmentId: "dept-a",
    permissions: ["reports.read", "reports.create", "reports.submit"]
  }
];

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    // DR-23: the pdf-snapshot signed-URL route calls Storage's
    // POST /storage/v1/object/sign/<bucket>/<path> -- distinct from every
    // other call this file stubs (PostgREST's /rest/v1/<table>), so it is
    // intercepted first and answered with a fixed signed-URL fragment,
    // matching createSignedUrl's expected {signedURL} response shape
    // (src/lib/storage.mjs). Recorded under the synthetic table name
    // "__storage_sign__" so a test can still inspect which path was signed.
    if (parsed.pathname.includes("/storage/v1/object/sign/")) {
      captured.push({
        table: "__storage_sign__",
        method: init.method,
        url: parsed,
        body: init.body ? JSON.parse(init.body) : null
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ signedURL: "/object/sign/attachments/mock-token" })
      };
    }
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

const BASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SUPABASE_STORAGE_BUCKET: "attachments"
};

function mount({ memberships = CREATOR, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerReportRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body, envOverrides = {}) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: { ...BASE_ENV, ...envOverrides }, params });
    return sent[sent.length - 1];
  }
  return { call };
}

test("GET report-templates denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/report-templates");
  assert.equal(result.status, 403);
});

test("GET report-templates returns published only by default", async (t) => {
  const captured = stubFetch(t, (table) => (table === "report_templates" ? [PUBLISHED_TEMPLATE] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-templates");
  assert.equal(result.status, 200);
  const get = captured.find((c) => c.table === "report_templates");
  assert.match(get.url.search, /status=eq\.published/);
});

test("GET report-templates?status=all drops the published filter", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  await call("GET", "/facilities/fac-1/report-templates?status=all");
  const get = captured.find((c) => c.table === "report_templates");
  assert.doesNotMatch(get.url.search, /status=eq/);
});

test("GET report-template by id includes the active version schema", async (t) => {
  stubFetch(t, (table) => {
    if (table === "report_templates") return [PUBLISHED_TEMPLATE];
    if (table === "report_template_versions") return [VERSION];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-templates/tpl-1");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.schema_json, SCHEMA);
  assert.equal(result.payload.active_version_id, "ver-3");
});

test("GET report-template by id 404s when missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/report-templates/nope");
  assert.equal(result.status, 404);
});

test("POST reports validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports", { reportDate: "not-a-date" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST reports denies a reader without reports.create", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-1",
    reportDate: "2026-07-18"
  });
  assert.equal(result.status, 403);
});

test("POST reports 409s when the template is not published", async (t) => {
  stubFetch(t, (table) =>
    table === "report_templates" ? [{ ...PUBLISHED_TEMPLATE, status: "draft" }] : []
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-1",
    reportDate: "2026-07-18"
  });
  assert.equal(result.status, 409);
});

test("POST reports happy path inserts a draft with the resolved version", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates") return [PUBLISHED_TEMPLATE];
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submissions" && method === "POST") return [{ id: "sub-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-1",
    reportDate: "2026-07-18",
    payload: { supervisor: "Sam" }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_submissions" && c.method === "POST");
  assert.equal(insert.body[0].template_id, "tpl-1");
  assert.equal(insert.body[0].template_version_id, "ver-3");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.deepEqual(insert.body[0].payload_json, { supervisor: "Sam" });
});

test("PATCH report edits a draft's payload", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        { id: "sub-1", facility_id: "fac-1", status: "draft", template_id: "tpl-1", template_version_id: "ver-3" }
      ];
    }
    // PATCH now validates a supplied payload against the pinned version's
    // schema, so the stub must serve that version.
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/reports/sub-1", { payload: { supervisor: "Kim" } });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.deepEqual(patch.body.payload_json, { supervisor: "Kim" });
});

test("PATCH report refuses to edit a submitted report (409)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-1", status: "submitted" }]
      : []
  );
  const { call } = mount();
  const result = await call("PATCH", "/reports/sub-1", { payload: { supervisor: "Kim" } });
  assert.equal(result.status, 409);
});

test("POST submit 422s when required fields are missing", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam" }
        }
      ];
    }
    if (table === "report_template_versions") return [VERSION];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 422);
  assert.ok(result.payload.errors.some((e) => /Attendance/.test(e)));
});

test("POST submit finalizes a valid draft and stamps the submitter", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount({ userId: "user-7" });
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.status, "submitted");
  assert.equal(patch.body.submitted_by, "user-7");
  assert.ok(patch.body.submitted_at);
});

test("POST submit refuses a non-draft report (409)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-1", status: "submitted", template_version_id: "ver-3" }]
      : []
  );
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 409);
});

// --- DR-11: department-scoped guards ---------------------------------------

test("POST reports allows a department-scoped creator to file for their own department", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates") return [DEPT_A_TEMPLATE];
    if (table === "report_template_versions") return [{ ...VERSION, template_id: "tpl-dept-a" }];
    if (table === "report_submissions" && method === "POST") return [{ id: "sub-dept-a" }];
    return [];
  });
  const { call } = mount({ memberships: DEPT_A_MEMBER });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-dept-a",
    reportDate: "2026-07-18",
    payload: { supervisor: "Sam", attendance: 5 }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_submissions" && c.method === "POST");
  assert.equal(insert.body[0].department_id, "dept-a");
});

test("POST reports denies a department-scoped creator filing for a different department", async (t) => {
  stubFetch(t, (table) => {
    if (table === "report_templates") return [{ ...PUBLISHED_TEMPLATE, id: "tpl-dept-b", department_id: "dept-b" }];
    return [];
  });
  const { call } = mount({ memberships: DEPT_A_MEMBER });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-dept-b",
    reportDate: "2026-07-18"
  });
  assert.equal(result.status, 403);
});

test("PATCH report allows a department-scoped submitter to edit their own department's draft", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-dept-a",
          facility_id: "fac-1",
          department_id: "dept-a",
          status: "draft",
          template_id: "tpl-dept-a",
          template_version_id: "ver-3"
        }
      ];
    }
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-dept-a" }];
    return [];
  });
  const { call } = mount({ memberships: DEPT_A_MEMBER });
  const result = await call("PATCH", "/reports/sub-dept-a", { payload: { supervisor: "Kim" } });
  assert.equal(result.status, 200);
});

test("PATCH report denies a department-scoped submitter editing a different department's draft", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-dept-b", facility_id: "fac-1", department_id: "dept-b", status: "draft" }]
      : []
  );
  const { call } = mount({ memberships: DEPT_A_MEMBER });
  const result = await call("PATCH", "/reports/sub-dept-b", { payload: { supervisor: "Kim" } });
  assert.equal(result.status, 403);
});

test("POST submit denies a department-scoped submitter for a different department", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-dept-b", facility_id: "fac-1", department_id: "dept-b", status: "draft" }]
      : []
  );
  const { call } = mount({ memberships: DEPT_A_MEMBER });
  const result = await call("POST", "/reports/sub-dept-b/submit");
  assert.equal(result.status, 403);
});

test("facility-wide creator is unaffected by department scoping", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates") return [{ ...PUBLISHED_TEMPLATE, id: "tpl-dept-b", department_id: "dept-b" }];
    if (table === "report_template_versions") return [{ ...VERSION, template_id: "tpl-dept-b" }];
    if (table === "report_submissions" && method === "POST") return [{ id: "sub-1" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/reports", {
    templateId: "tpl-dept-b",
    reportDate: "2026-07-18",
    payload: { supervisor: "Sam", attendance: 5 }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_submissions" && c.method === "POST");
  assert.equal(insert.body[0].department_id, "dept-b");
});

// --- DR-12: compliance endpoint ---------------------------------------------

test("GET reports/compliance requires from and to", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const missingFrom = await call("GET", "/facilities/fac-1/reports/compliance?to=2026-08-01");
  assert.equal(missingFrom.status, 400);
  const missingTo = await call("GET", "/facilities/fac-1/reports/compliance?from=2026-08-01");
  assert.equal(missingTo.status, 400);
});

test("GET reports/compliance denies a non-member with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call(
    "GET",
    "/facilities/fac-1/reports/compliance?from=2026-08-01&to=2026-08-02"
  );
  assert.equal(result.status, 403);
});

test("GET reports/compliance computes a summary from templates + submissions", async (t) => {
  stubFetch(t, (table) => {
    if (table === "report_templates") return [PUBLISHED_TEMPLATE];
    if (table === "report_submissions") {
      return [{ template_id: "tpl-1", report_date: "2026-08-01", status: "submitted" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call(
    "GET",
    "/facilities/fac-1/reports/compliance?from=2026-08-01&to=2026-08-02"
  );
  assert.equal(result.status, 200);
  assert.equal(result.payload.templates.length, 1);
  assert.equal(result.payload.templates[0].templateId, "tpl-1");
  assert.equal(result.payload.templates[0].submitted, 1);
});

// --- DR-15: single-submission PDF export ------------------------------------

const ENABLED_FLAG = {
  id: "flag-pdf",
  key: "reports.pdf_export",
  description: "PDF export",
  rollout_type: "boolean",
  default_state: true
};
const DISABLED_FLAG = { ...ENABLED_FLAG, default_state: false };

function pdfStub(t, { flag = ENABLED_FLAG, submission } = {}) {
  return stubFetch(t, (table) => {
    if (table === "report_submissions") return [submission];
    if (table === "facilities") return [{ id: "fac-1", name: "Facility One", organization_id: "org-1" }];
    if (table === "feature_flags") return flag ? [flag] : [];
    if (table === "feature_flag_rules") return [];
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_templates") return [PUBLISHED_TEMPLATE];
    if (table === "departments") return [{ id: "dept-1", name: "Aquatics" }];
    if (table === "app_users") return [{ id: "user-1", full_name: "Sam Submitter" }];
    return [];
  });
}

const SUBMITTED_REPORT = {
  id: "sub-1",
  facility_id: "fac-1",
  department_id: "dept-1",
  template_id: "tpl-1",
  template_version_id: "ver-3",
  report_date: "2026-07-18",
  status: "submitted",
  submitted_by: "user-1",
  submitted_at: "2026-07-18T20:00:00.000Z",
  payload_json: { supervisor: "Sam", attendance: 12 }
};

test("GET reports/:id/pdf denies a caller without reports.export", async (t) => {
  pdfStub(t, { submission: SUBMITTED_REPORT });
  const { call } = mount({ memberships: [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }] });
  const result = await call("GET", "/reports/sub-1/pdf");
  assert.equal(result.status, 403);
});

test("GET reports/:id/pdf 409s a draft submission", async (t) => {
  pdfStub(t, { submission: { ...SUBMITTED_REPORT, status: "draft" } });
  const { call } = mount({
    memberships: [{ facilityId: "fac-1", status: "active", permissions: ["reports.export"] }]
  });
  const result = await call("GET", "/reports/sub-1/pdf");
  assert.equal(result.status, 409);
});

test("GET reports/:id/pdf 403s when the pdf_export flag is off", async (t) => {
  pdfStub(t, { flag: DISABLED_FLAG, submission: SUBMITTED_REPORT });
  const { call } = mount({
    memberships: [{ facilityId: "fac-1", status: "active", permissions: ["reports.export"] }]
  });
  const result = await call("GET", "/reports/sub-1/pdf");
  assert.equal(result.status, 403);
});

test("GET reports/:id/pdf returns the export envelope for a submitted report", async (t) => {
  pdfStub(t, { submission: SUBMITTED_REPORT });
  const { call } = mount({
    memberships: [{ facilityId: "fac-1", status: "active", permissions: ["reports.export"] }]
  });
  const result = await call("GET", "/reports/sub-1/pdf");
  assert.equal(result.status, 200);
  assert.equal(result.payload.contentType, "application/pdf");
  assert.equal(result.payload.encoding, "base64");
  assert.ok(result.payload.contentDisposition.includes("attachment"));
  const bytes = Buffer.from(result.payload.body, "base64").toString("latin1");
  assert.ok(bytes.startsWith("%PDF-1.4\n"));
});

// --- DR-16: hidden_fields recorded on validation_results at submit ----------

const VISIBILITY_SCHEMA = {
  sections: [
    {
      title: "Opening",
      fields: [
        { key: "supervisor", label: "Supervisor", type: "text", required: true },
        {
          key: "pool_temp",
          label: "Pool temperature",
          type: "number",
          required: true,
          visibility_rules: [{ field: "supervisor", op: "eq", value: "nobody" }]
        }
      ]
    }
  ]
};
const VISIBILITY_VERSION = { ...VERSION, schema_json: VISIBILITY_SCHEMA };

test("POST submit records hidden_fields on validation_results even with no other warnings", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam" }
        }
      ];
    }
    if (table === "report_template_versions") return [VISIBILITY_VERSION];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.deepEqual(patch.body.validation_results, { hidden_fields: ["pool_temp"] });
});

// L-3 (security review): a value submitted FOR a hidden field was a known
// schema key (passes unknownPayloadKeys) but never validated at all (never
// required, never type/range/regex checked) -- persisted as unvalidated
// garbage. Submit now strips every currently-hidden key out of what
// actually gets written to payload_json.
test("POST submit strips a value planted on a hidden field out of the persisted payload_json", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          // pool_temp is hidden (supervisor !== "nobody") but still carries
          // an attacker/garbage-planted value that was never validated.
          payload_json: { supervisor: "Sam", pool_temp: "not even a number" }
        }
      ];
    }
    if (table === "report_template_versions") return [VISIBILITY_VERSION];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.deepEqual(patch.body.payload_json, { supervisor: "Sam" });
  assert.deepEqual(patch.body.validation_results, { hidden_fields: ["pool_temp"] });
});

// --- DR-17: signatures -------------------------------------------------------

const SIG_REQUIRED_VERSION = {
  ...VERSION,
  validation_json: { signature_requirements: { required: true, roles: ["manager"] } }
};

test("POST submit is blocked (400) with the missing roles when a required signature is absent", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [SIG_REQUIRED_VERSION];
    if (table === "report_submission_signatures") return [];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 400);
  assert.deepEqual(result.payload.missingRoles, ["manager"]);
  assert.ok(!captured.some((c) => c.table === "report_submissions" && c.method === "PATCH"));
});

test("POST submit succeeds once every required role has signed with a fresh (non-stale) signature", async (t) => {
  const submissionPayload = { supervisor: "Sam", attendance: 42 };
  const freshHash = signatureHash({
    submissionId: "sub-1",
    userId: "user-5",
    role: "manager",
    payload: submissionPayload
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          payload_json: submissionPayload
        }
      ];
    }
    if (table === "report_template_versions") return [SIG_REQUIRED_VERSION];
    if (table === "report_submission_signatures") {
      return [{ signer_user_id: "user-5", signer_role: "manager", signature_hash: freshHash }];
    }
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  assert.ok(captured.some((c) => c.table === "report_submissions" && c.method === "PATCH"));
});

// --- M-2: signature hashes are re-verified against the CURRENT payload -----

test("POST submit is blocked (409) when the payload changed after a signature was recorded", async (t) => {
  const signedPayload = { supervisor: "Sam", attendance: 42 };
  const staleHash = signatureHash({
    submissionId: "sub-1",
    userId: "user-5",
    role: "manager",
    payload: signedPayload
  });
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          // The payload was edited (attendance 42 -> 99) AFTER signing --
          // still legal (still draft, still reports.submit), but the
          // recorded hash no longer matches.
          payload_json: { supervisor: "Sam", attendance: 99 }
        }
      ];
    }
    if (table === "report_template_versions") return [SIG_REQUIRED_VERSION];
    if (table === "report_submission_signatures") {
      return [{ signer_user_id: "user-5", signer_role: "manager", signature_hash: staleHash }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 409);
  assert.equal(result.payload.error, "signatures are stale");
  assert.deepEqual(result.payload.staleRoles, ["manager"]);
  assert.ok(!captured.some((c) => c.table === "report_submissions" && c.method === "PATCH"));
});

test("POST submit succeeds with no signature rows at all (nothing to verify)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [VERSION];
    if (table === "report_submission_signatures") return [];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  assert.ok(captured.some((c) => c.table === "report_submissions" && c.method === "PATCH"));
});

// POST /facilities/:facilityId/reports/:id/signatures

test("POST reports/:id/signatures rejects a missing role before any fetch (400)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", {});
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST reports/:id/signatures 404s when the submission belongs to a different facility", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-2", status: "draft", template_version_id: "ver-3" }]
      : []
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "manager" });
  assert.equal(result.status, 404);
});

test("POST reports/:id/signatures denies a caller without reports.submit (403)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-1", status: "draft", template_version_id: "ver-3" }]
      : []
  );
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "manager" });
  assert.equal(result.status, 403);
});

test("POST reports/:id/signatures refuses a non-draft submission (409)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET"
      ? [{ id: "sub-1", facility_id: "fac-1", status: "submitted", template_version_id: "ver-3" }]
      : []
  );
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "manager" });
  assert.equal(result.status, 409);
});

test("POST reports/:id/signatures rejects a role not on the template's signature_requirements list (400)", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [{ id: "sub-1", facility_id: "fac-1", status: "draft", template_version_id: "ver-3" }];
    }
    if (table === "report_template_versions") return [SIG_REQUIRED_VERSION];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "janitor" });
  assert.equal(result.status, 400);
});

test("POST reports/:id/signatures happy path inserts a signature attributed to the caller", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          status: "draft",
          template_version_id: "ver-3",
          payload_json: { supervisor: "Sam" }
        }
      ];
    }
    if (table === "report_template_versions") return [SIG_REQUIRED_VERSION];
    if (table === "report_submission_signatures" && method === "POST") return [{ id: "sig-1" }];
    return [];
  });
  const { call } = mount({ userId: "user-9" });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "manager" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_submission_signatures" && c.method === "POST");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].submission_id, "sub-1");
  assert.equal(insert.body[0].signer_user_id, "user-9");
  assert.equal(insert.body[0].signer_role, "manager");
  assert.match(insert.body[0].signature_hash, /^[0-9a-f]{64}$/);
});

// --- M-3: a signer_role requires its own mapped permission ------------------

const PUBLISH_ROLE_VERSION = {
  ...VERSION,
  validation_json: {
    signature_requirements: {
      required: true,
      roles: [{ role: "supervisor", permission: "reports.publish" }]
    }
  }
};

test("POST reports/:id/signatures denies a plain reports.submit holder signing a role that requires reports.publish (403)", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [{ id: "sub-1", facility_id: "fac-1", status: "draft", template_version_id: "ver-3" }];
    }
    if (table === "report_template_versions") return [PUBLISH_ROLE_VERSION];
    return [];
  });
  // CREATOR holds reports.submit (enough to reach the route at all) but not
  // reports.publish (the role's own mapped permission) -- one submitter
  // cannot satisfy a role that requires reports.publish.
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "supervisor" });
  assert.equal(result.status, 403);
  assert.match(result.payload.error, /reports\.publish/);
});

test("POST reports/:id/signatures allows a caller who holds the role's own mapped permission", async (t) => {
  const publisher = [
    {
      facilityId: "fac-1",
      status: "active",
      permissions: ["reports.read", "reports.submit", "reports.publish"]
    }
  ];
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        { id: "sub-1", facility_id: "fac-1", status: "draft", template_version_id: "ver-3", payload_json: {} }
      ];
    }
    if (table === "report_template_versions") return [PUBLISH_ROLE_VERSION];
    if (table === "report_submission_signatures" && method === "POST") return [{ id: "sig-1" }];
    return [];
  });
  const { call } = mount({ memberships: publisher, userId: "user-11" });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "supervisor" });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_submission_signatures" && c.method === "POST");
  assert.equal(insert.body[0].signer_role, "supervisor");
});

test("POST reports/:id/signatures: a bare string role still normalizes to reports.submit (backward compatible)", async (t) => {
  // SIG_REQUIRED_VERSION's roles are bare strings ["manager"] -- every
  // existing CREATOR-shaped caller (reports.submit, nothing more) can still
  // sign, exactly like before M-3.
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [{ id: "sub-1", facility_id: "fac-1", status: "draft", template_version_id: "ver-3", payload_json: {} }];
    }
    if (table === "report_template_versions") return [SIG_REQUIRED_VERSION];
    if (table === "report_submission_signatures" && method === "POST") return [{ id: "sig-1" }];
    return [];
  });
  const { call } = mount({ memberships: CREATOR });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/signatures", { role: "manager" });
  assert.equal(result.status, 201);
});

// GET /facilities/:facilityId/reports/:id/signatures

test("GET reports/:id/signatures 404s when the submission belongs to a different facility", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET" ? [{ id: "sub-1", facility_id: "fac-2" }] : []
  );
  const { call } = mount();
  const result = await call("GET", "/facilities/fac-1/reports/sub-1/signatures");
  assert.equal(result.status, 404);
});

test("GET reports/:id/signatures denies a caller without reports.read on that facility (403)", async (t) => {
  stubFetch(t, (table, method) =>
    table === "report_submissions" && method === "GET" ? [{ id: "sub-1", facility_id: "fac-1" }] : []
  );
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/reports/sub-1/signatures");
  assert.equal(result.status, 403);
});

test("GET reports/:id/signatures returns the recorded signatures", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [{ id: "sub-1", facility_id: "fac-1" }];
    if (table === "report_submission_signatures") {
      return [{ id: "sig-1", submission_id: "sub-1", signer_role: "manager" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/reports/sub-1/signatures");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].signer_role, "manager");

  // L-1 (security review): report_submission_signatures (0052) has no
  // created_at column -- selecting it made PostgREST answer the whole
  // request with a 400 in production. Assert the select list this route
  // actually sends never asks for it again.
  const get = captured.find((c) => c.table === "report_submission_signatures" && c.method === "GET");
  const selected = get.url.searchParams.get("select").split(",");
  assert.ok(!selected.includes("created_at"), `select list must not include created_at: ${selected.join(",")}`);
  assert.ok(selected.includes("signed_at"));
});

// --- DR-18/DR-19/H-1: submit-time workflow enqueue --------------------------
// H-1 (security review): the route no longer evaluates the workflow or
// builds an action list at all -- internal.enqueue_report_workflow (0053)
// now takes ONLY p_submission_id, and report-workflow-executor.mjs's
// executor is what derives the action list server-side. workflow_json on
// the version is therefore irrelevant to this route entirely; these tests
// only need a non-sandbox report_templates row so enqueueWorkflow's L-6
// fail-closed sandbox re-check finds a resolvable template.

const WORKFLOW_VERSION = {
  id: "ver-wf",
  template_id: "tpl-1",
  version_number: 1,
  schema_json: SCHEMA,
  is_published: true
};
const NON_SANDBOX_TEMPLATE = { id: "tpl-1", sandbox: false };

test("POST submit calls internal.enqueue_report_workflow with ONLY the submission id", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          department_id: null,
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-wf",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [WORKFLOW_VERSION];
    if (table === "report_templates") return [NON_SANDBOX_TEMPLATE];
    if (table === "report_submissions" && method === "PATCH") {
      return [{ id: "sub-1", facility_id: "fac-1", template_id: "tpl-1", status: "submitted" }];
    }
    if (table === "rpc/enqueue_report_workflow" && method === "POST") {
      return { submission_id: "sub-1", event_id: "evt-1", enqueued: true };
    }
    return [];
  });
  const { call } = mount({ userId: "user-7" });
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);

  const rpcCall = captured.find((c) => c.table === "rpc/enqueue_report_workflow" && c.method === "POST");
  assert.ok(rpcCall, "expected the submit route to call internal.enqueue_report_workflow");
  assert.equal(rpcCall.body.p_submission_id, "sub-1");
  // H-1's whole point: no action list, no params of any kind -- there is
  // nothing left for a caller-influenced route to inject.
  assert.deepEqual(Object.keys(rpcCall.body), ["p_submission_id"]);
});

test("POST submit on a sandbox template (DR-26) enqueues nothing: no workflow RPC", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          department_id: null,
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-wf",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [WORKFLOW_VERSION];
    if (table === "report_templates") return [{ id: "tpl-1", sandbox: true }];
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  assert.ok(!captured.some((c) => c.table === "rpc/enqueue_report_workflow"), "sandbox must not enqueue");
});

// L-6 (security review): the prior version re-read report_templates under
// the CALLER's own RLS session and treated ANY empty result (a genuinely
// missing row, OR a reports.submit holder who lacks reports.read on
// report_templates and gets an RLS-narrowed empty read) the same as "not
// sandbox" -- failing OPEN. Fixed to fail CLOSED: an unresolvable template
// row now skips enqueueing entirely rather than assuming it is safe.
test("POST submit does not enqueue when the template lookup returns no rows (fails closed, not open)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") {
      return [
        {
          id: "sub-1",
          facility_id: "fac-1",
          department_id: null,
          status: "draft",
          template_id: "tpl-1",
          template_version_id: "ver-wf",
          payload_json: { supervisor: "Sam", attendance: 42 }
        }
      ];
    }
    if (table === "report_template_versions") return [WORKFLOW_VERSION];
    if (table === "report_templates") return []; // RLS-narrowed / missing -- unresolvable
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200, "the submit itself must still succeed");
  assert.ok(
    !captured.some((c) => c.table === "rpc/enqueue_report_workflow"),
    "an unresolvable template must fail CLOSED -- no enqueue, not an assumed non-sandbox enqueue"
  );
});

test("POST submit still returns 200 when the workflow enqueue RPC call itself rejects", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    if (table === "rpc/enqueue_report_workflow") {
      return { ok: false, status: 500, text: async () => JSON.stringify({ message: "boom" }) };
    }
    const method = init.method;
    if (table === "report_submissions" && method === "GET") {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              id: "sub-1",
              facility_id: "fac-1",
              department_id: null,
              status: "draft",
              template_id: "tpl-1",
              template_version_id: "ver-wf",
              payload_json: { supervisor: "Sam", attendance: 42 }
            }
          ])
      };
    }
    if (table === "report_template_versions") {
      return { ok: true, status: 200, text: async () => JSON.stringify([WORKFLOW_VERSION]) };
    }
    if (table === "report_templates") {
      return { ok: true, status: 200, text: async () => JSON.stringify([NON_SANDBOX_TEMPLATE]) };
    }
    if (table === "report_submissions" && method === "PATCH") {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "sub-1", status: "submitted" }]) };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { call } = mount({ userId: "user-7" });
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "submitted");
});

// --- GET reports/:id/detail: DR-24 successorId -------------------------------

test("GET reports/:id/detail resolves successorId by looking up revision_of", async (t) => {
  // Two different GETs against report_submissions happen in this route:
  // loadSubmission (filters on id) and the successor lookup (filters on
  // revision_of) -- distinguished by query param, so this test builds its
  // own url-aware stub directly rather than the generic table-keyed one.
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    if (table === "report_submissions") {
      if (parsed.searchParams.get("id") === "eq.sub-1") {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ ...SUBMITTED_REPORT, status: "revised" }]) };
      }
      if (parsed.searchParams.get("revision_of") === "eq.sub-1") {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "sub-2" }]) };
      }
      return { ok: true, status: 200, text: async () => "[]" };
    }
    if (table === "report_template_versions") return { ok: true, status: 200, text: async () => JSON.stringify([VERSION]) };
    if (table === "report_templates") return { ok: true, status: 200, text: async () => JSON.stringify([PUBLISHED_TEMPLATE]) };
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/reports/sub-1/detail");
  assert.equal(result.status, 200);
  assert.equal(result.payload.successorId, "sub-2");
});

test("GET reports/:id/detail leaves successorId null for a non-revised row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [SUBMITTED_REPORT];
    if (table === "report_template_versions" && method === "GET") return [VERSION];
    if (table === "report_templates" && method === "GET") return [PUBLISHED_TEMPLATE];
    if (table === "report_submission_attachments" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/reports/sub-1/detail");
  assert.equal(result.status, 200);
  assert.equal(result.payload.successorId, null);
  assert.ok(!captured.some((c) => c.table === "report_submissions" && c.url.searchParams.has("revision_of")));
});

// --- WO-21: workflow pending/failed counts on the detail response ----------

test("GET reports/:id/detail surfaces workflow: {pending, failed} counts from report_workflow_events", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [SUBMITTED_REPORT];
    if (table === "report_template_versions" && method === "GET") return [VERSION];
    if (table === "report_templates" && method === "GET") return [PUBLISHED_TEMPLATE];
    if (table === "report_submission_attachments" && method === "GET") return [];
    if (table === "report_workflow_events" && method === "GET") {
      return [{ status: "pending" }, { status: "processing" }, { status: "failed" }, { status: "failed" }];
    }
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/reports/sub-1/detail");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.workflow, { pending: 2, failed: 2 });
});

test("GET reports/:id/detail reports workflow: {pending:0, failed:0} when there are no ledger rows", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [SUBMITTED_REPORT];
    if (table === "report_template_versions" && method === "GET") return [VERSION];
    if (table === "report_templates" && method === "GET") return [PUBLISHED_TEMPLATE];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/reports/sub-1/detail");
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.workflow, { pending: 0, failed: 0 });
});

// --- DR-24: lock / revise ----------------------------------------------------

const PUBLISHER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read", "reports.publish"] }];

function lockRouteStub(t, { submission, patched } = {}) {
  return stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [submission];
    if (table === "report_submissions" && method === "PATCH") return [patched ?? { ...submission, status: "locked" }];
    return [];
  });
}

test("POST reports/:id/lock 404s when the report belongs to a different facility", async (t) => {
  lockRouteStub(t, { submission: { ...SUBMITTED_REPORT, facility_id: "fac-2" } });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/lock");
  assert.equal(result.status, 404);
});

test("POST reports/:id/lock denies a caller without reports.publish", async (t) => {
  lockRouteStub(t, { submission: SUBMITTED_REPORT });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/lock");
  assert.equal(result.status, 403);
});

test("POST reports/:id/lock 409s a draft report", async (t) => {
  lockRouteStub(t, { submission: { ...SUBMITTED_REPORT, status: "draft" } });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/lock");
  assert.equal(result.status, 409);
});

test("POST reports/:id/lock 409s an already-locked report", async (t) => {
  lockRouteStub(t, { submission: { ...SUBMITTED_REPORT, status: "locked" } });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/lock");
  assert.equal(result.status, 409);
});

test("POST reports/:id/lock happy path flips a submitted report to locked", async (t) => {
  const captured = lockRouteStub(t, { submission: SUBMITTED_REPORT });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/lock");
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, "locked");
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.status, "locked");
  assert.equal(patch.url.searchParams.get("id"), "eq.sub-1");
});

function reviseRouteStub(t, { submission } = {}) {
  return stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [submission];
    if (table === "report_submissions" && method === "POST") {
      return [{ ...submission, id: "sub-2", status: "draft", revision_of: submission.id }];
    }
    if (table === "report_submissions" && method === "PATCH") return [{ ...submission, status: "revised" }];
    return [];
  });
}

test("POST reports/:id/revise denies a caller without reports.publish", async (t) => {
  reviseRouteStub(t, { submission: SUBMITTED_REPORT });
  const { call } = mount({ memberships: READER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/revise");
  assert.equal(result.status, 403);
});

test("POST reports/:id/revise 409s a draft report", async (t) => {
  reviseRouteStub(t, { submission: { ...SUBMITTED_REPORT, status: "draft" } });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/revise");
  assert.equal(result.status, 409);
});

test("POST reports/:id/revise allows a locked report and mints a draft successor", async (t) => {
  const captured = reviseRouteStub(t, { submission: { ...SUBMITTED_REPORT, status: "locked" } });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/revise");
  assert.equal(result.status, 200);
  assert.equal(result.payload.original.status, "revised");
  assert.equal(result.payload.successor.revision_of, "sub-1");
  assert.equal(result.payload.successor.status, "draft");

  const insert = captured.find((c) => c.table === "report_submissions" && c.method === "POST");
  assert.equal(insert.body[0].revision_of, "sub-1");
  assert.equal(insert.body[0].status, "draft");
  assert.equal(insert.body[0].payload_json.supervisor, "Sam");

  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.status, "revised");

  // Insert happens before the original's UPDATE (safer failure ordering --
  // see the route's own comment).
  assert.ok(captured.indexOf(insert) < captured.indexOf(patch));
});

test("POST reports/:id/revise allows a submitted report", async (t) => {
  reviseRouteStub(t, { submission: SUBMITTED_REPORT });
  const { call } = mount({ memberships: PUBLISHER });
  const result = await call("POST", "/facilities/fac-1/reports/sub-1/revise");
  assert.equal(result.status, 200);
});

// --- DR-23: PDF snapshot signed URL ------------------------------------------

function snapshotStub(t, { submission } = {}) {
  return stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [submission];
    return [];
  });
}

// assertPathInFacility (src/lib/storage.mjs) requires a real UUID-shaped
// facility id -- every other fixture in this file uses the plain "fac-1"
// shorthand, which is fine for routes that never touch Storage, but this
// route does, so these tests get their own UUID facility id (same
// convention as test/attachments-routes.test.mjs's FAC_1/FAC_2).
const SNAPSHOT_FACILITY_ID = "33333333-3333-3333-3333-333333333333";
const SNAPSHOT_MEMBER = [{ facilityId: SNAPSHOT_FACILITY_ID, status: "active", permissions: ["reports.export"] }];
const SNAPSHOT_READER = [{ facilityId: SNAPSHOT_FACILITY_ID, status: "active", permissions: ["reports.read"] }];

const GENERATED_REPORT = {
  ...SUBMITTED_REPORT,
  facility_id: SNAPSHOT_FACILITY_ID,
  pdf_status: "generated",
  pdf_storage_path: `facilities/${SNAPSHOT_FACILITY_ID}/reports/sub-1/snapshot-abcdef12.pdf`,
  pdf_content_hash: "a".repeat(64)
};

test("GET facilities/:facilityId/reports/:id/pdf denies a caller without reports.export", async (t) => {
  snapshotStub(t, { submission: GENERATED_REPORT });
  const { call } = mount({ memberships: SNAPSHOT_READER });
  const result = await call("GET", `/facilities/${SNAPSHOT_FACILITY_ID}/reports/sub-1/pdf`);
  assert.equal(result.status, 403);
});

test("GET facilities/:facilityId/reports/:id/pdf 404s while the snapshot is still queued", async (t) => {
  snapshotStub(t, { submission: { ...GENERATED_REPORT, pdf_status: "queued", pdf_storage_path: null } });
  const { call } = mount({ memberships: SNAPSHOT_MEMBER });
  const result = await call("GET", `/facilities/${SNAPSHOT_FACILITY_ID}/reports/sub-1/pdf`);
  assert.equal(result.status, 404);
});

test("GET facilities/:facilityId/reports/:id/pdf 404s when the report belongs to a different facility", async (t) => {
  snapshotStub(t, { submission: { ...GENERATED_REPORT, facility_id: "44444444-4444-4444-4444-444444444444" } });
  const { call } = mount({ memberships: SNAPSHOT_MEMBER });
  const result = await call("GET", `/facilities/${SNAPSHOT_FACILITY_ID}/reports/sub-1/pdf`);
  assert.equal(result.status, 404);
});

test("GET facilities/:facilityId/reports/:id/pdf returns a signed url once generated", async (t) => {
  const captured = snapshotStub(t, { submission: GENERATED_REPORT });
  const { call } = mount({ memberships: SNAPSHOT_MEMBER });
  const result = await call("GET", `/facilities/${SNAPSHOT_FACILITY_ID}/reports/sub-1/pdf`);
  assert.equal(result.status, 200);
  assert.ok(result.payload.url.includes("/storage/v1/object/sign/attachments/mock-token"));
  assert.equal(result.payload.expiresInSeconds, 300);
  const sign = captured.find((c) => c.table === "__storage_sign__");
  // The path is percent-encoded segment-by-segment (storage.mjs's
  // encodeObjectPath); decode it back and confirm it's exactly this row's
  // own pdf_storage_path.
  const decodedPath = sign.url.pathname
    .split("/storage/v1/object/sign/attachments/")[1]
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  assert.equal(decodedPath, GENERATED_REPORT.pdf_storage_path);
});
