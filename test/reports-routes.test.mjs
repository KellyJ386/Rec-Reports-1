import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerReportRoutes } from "../src/lib/http/reports-routes.mjs";
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

function mount({ memberships = CREATOR, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerReportRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
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

test("POST submit succeeds once every required role has signed", async (t) => {
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
    if (table === "report_submission_signatures") return [{ signer_role: "manager" }];
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
  stubFetch(t, (table, method) => {
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
});

// --- DR-18/DR-19: submit-time workflow enqueue ------------------------------

const WORKFLOW_VERSION = {
  id: "ver-wf",
  template_id: "tpl-1",
  version_number: 1,
  schema_json: SCHEMA,
  workflow_json: { on_submit: ["queue_pdf", "notify_managers"] },
  is_published: true
};

test("POST submit enqueues workflow events via internal.enqueue_report_workflow", async (t) => {
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
    if (table === "report_submissions" && method === "PATCH") return [{ id: "sub-1", status: "submitted" }];
    if (table === "rpc/enqueue_report_workflow" && method === "POST") {
      return { submission_id: "sub-1", event_ids: ["evt-1", "evt-2"] };
    }
    return [];
  });
  const { call } = mount({ userId: "user-7" });
  const result = await call("POST", "/reports/sub-1/submit");
  assert.equal(result.status, 200);

  const rpcCall = captured.find((c) => c.table === "rpc/enqueue_report_workflow" && c.method === "POST");
  assert.ok(rpcCall, "expected the submit route to call internal.enqueue_report_workflow");
  assert.equal(rpcCall.body.p_submission_id, "sub-1");
  assert.equal(rpcCall.body.p_actions.length, 2);
  assert.equal(rpcCall.body.p_actions[0].type, "queue_pdf");
  assert.equal(rpcCall.body.p_actions[1].type, "notify");
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
