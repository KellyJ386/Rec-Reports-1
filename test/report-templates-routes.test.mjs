import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerReportTemplatesRoutes } from "../src/lib/http/report-templates-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [
  { facilityId: "fac-1", status: "active", permissions: ["reports.template.manage", "reports.publish"] }
];
const MANAGER_NO_PUBLISH = [
  { facilityId: "fac-1", status: "active", permissions: ["reports.template.manage"] }
];
const MEMBER = [{ facilityId: "fac-1", status: "active", permissions: ["reports.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["reports.template.manage", "reports.publish"] }];

const VALID_SCHEMA = {
  sections: [{ title: "Fields", fields: [{ key: "k1", label: "K1", type: "text", required: true }] }]
};

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

function mount({ memberships = MANAGER, userId = "user-1" } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerReportTemplatesRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env: {}, params });
    return sent[sent.length - 1];
  }
  return { call };
}

// --- GET /facilities/:facilityId/report-templates --------------------------

test("GET report-templates denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/report-templates");
  assert.equal(result.status, 403);
});

test("GET report-templates allows a plain member (read is not manage-gated)", async (t) => {
  stubFetch(t, () => [{ id: "t-1" }]);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("GET", "/facilities/fac-1/report-templates");
  assert.equal(result.status, 200);
});

// --- POST /facilities/:facilityId/report-templates --------------------------

test("POST report-templates validates before guarding (400 on bad input, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/report-templates", { code: "Not Snake", name: "x" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST report-templates denies a member without reports.template.manage", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/facilities/fac-1/report-templates", {
    code: "opening_checklist",
    name: "Opening Checklist"
  });
  assert.equal(result.status, 403);
});

test("POST report-templates happy path inserts a draft row", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "POST") return [{ id: "t-1", status: "draft" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/facilities/fac-1/report-templates", {
    code: "opening_checklist",
    name: "Opening Checklist"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_templates" && c.method === "POST");
  assert.equal(insert.body[0].code, "opening_checklist");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].status, "draft");
});

// --- PATCH /report-templates/:id --------------------------------------------

test("PATCH /report-templates/:id 404s when the template is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/report-templates/missing", { name: "New Name" });
  assert.equal(result.status, 404);
});

test("PATCH /report-templates/:id denies a member without reports.template.manage before any write", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount({ memberships: MEMBER });
  const result = await call("PATCH", "/report-templates/t-1", { name: "New Name" });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "report_templates" && c.method === "PATCH"));
});

test("PATCH /report-templates/:id rejects an empty patch with 400", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-templates/t-1", {});
  assert.equal(result.status, 400);
});

test("PATCH /report-templates/:id happy path updates the row", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_templates" && method === "PATCH") {
      return [{ id: url.searchParams.get("id"), name: "New Name" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-templates/t-1", { name: "New Name" });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_templates" && c.method === "PATCH");
  assert.equal(patch.body.name, "New Name");
  assert.ok(patch.body.updated_at);
});

// --- POST /report-templates/:id/archive -------------------------------------

test("POST /report-templates/:id/archive denies a member without reports.template.manage", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/report-templates/t-1/archive");
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "report_templates" && c.method === "PATCH"));
});

test("POST /report-templates/:id/archive happy path sets status archived", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_templates" && method === "PATCH") {
      return [{ id: url.searchParams.get("id"), status: "archived" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/report-templates/t-1/archive");
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_templates" && c.method === "PATCH");
  assert.equal(patch.body.status, "archived");
});

// --- GET /report-templates/:id/versions -------------------------------------

test("GET /report-templates/:id/versions 404s when the template is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("GET", "/report-templates/missing/versions");
  assert.equal(result.status, 404);
});

test("GET /report-templates/:id/versions allows a plain member", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_template_versions" && method === "GET") return [{ id: "v-1", version_number: 1 }];
    return [];
  });
  const { call } = mount({ memberships: MEMBER });
  const result = await call("GET", "/report-templates/t-1/versions");
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
});

// --- POST /report-templates/:id/versions ------------------------------------

test("POST /report-templates/:id/versions rejects an invalid schema with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/report-templates/t-1/versions", { schema: { sections: [] } });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST /report-templates/:id/versions denies a member without reports.template.manage", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/report-templates/t-1/versions", { schema: VALID_SCHEMA });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "POST"));
});

test("POST /report-templates/:id/versions creates a draft at version = max(existing) + 1", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_template_versions" && method === "GET") {
      return [{ version_number: 1 }, { version_number: 2 }];
    }
    if (table === "report_template_versions" && method === "POST") return [{ id: "v-3", version_number: 3 }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/report-templates/t-1/versions", { schema: VALID_SCHEMA });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_template_versions" && c.method === "POST");
  assert.equal(insert.body[0].version_number, 3);
  assert.equal(insert.body[0].template_id, "t-1");
  assert.equal(insert.body[0].facility_id, "fac-1");
});

// --- DR-17: signature_requirements validated on validationJson at version
// creation time (report-schema.mjs's validateSignatureRequirements) --------

test("POST /report-templates/:id/versions accepts a well-formed signature_requirements", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_template_versions" && method === "GET") return [];
    if (table === "report_template_versions" && method === "POST") return [{ id: "v-1", version_number: 1 }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/report-templates/t-1/versions", {
    schema: VALID_SCHEMA,
    validationJson: { signature_requirements: { required: true, roles: ["manager"] } }
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "report_template_versions" && c.method === "POST");
  assert.deepEqual(insert.body[0].validation_json, {
    signature_requirements: { required: true, roles: ["manager"] }
  });
});

test("POST /report-templates/:id/versions rejects a malformed signature_requirements with 400 before any fetch", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/report-templates/t-1/versions", {
    schema: VALID_SCHEMA,
    validationJson: { signature_requirements: { required: "yes" } }
  });
  assert.equal(result.status, 400);
  assert.ok(result.payload.errors.some((e) => /signature_requirements: .*required must be a boolean/.test(e)));
  assert.equal(captured.length, 0);
});

// --- PATCH /report-template-versions/:id ------------------------------------

test("PATCH /report-template-versions/:id 404s when the version is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("PATCH", "/report-template-versions/missing", { schema: VALID_SCHEMA });
  assert.equal(result.status, 404);
});

test("PATCH /report-template-versions/:id denies a member without reports.template.manage before any write", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", is_published: false }];
    }
    return [];
  });
  const { call } = mount({ memberships: MEMBER });
  const result = await call("PATCH", "/report-template-versions/v-1", { schema: VALID_SCHEMA });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
});

test("PATCH /report-template-versions/:id rejects a published version with 409", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", is_published: true }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-template-versions/v-1", { schema: VALID_SCHEMA });
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
});

test("PATCH /report-template-versions/:id rejects an invalid schema with 400 before any write", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", is_published: false }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-template-versions/v-1", { schema: { sections: [] } });
  assert.equal(result.status, 400);
  assert.ok(Array.isArray(result.payload.errors));
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
});

test("PATCH /report-template-versions/:id happy path updates the schema in place", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", is_published: false }];
    }
    if (table === "report_template_versions" && method === "PATCH") {
      return [{ id: url.searchParams.get("id"), schema_json: VALID_SCHEMA }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-template-versions/v-1", { schema: VALID_SCHEMA });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_template_versions" && c.method === "PATCH");
  assert.deepEqual(patch.body.schema_json, VALID_SCHEMA);
});

// --- POST /report-template-versions/:id/publish -----------------------------

const CHANGE_SUMMARY = { changeSummary: "Publishing the revised opening checklist." };

test("POST /report-template-versions/:id/publish 400s without a changeSummary (no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/report-template-versions/v-1/publish", { changeSummary: "  " });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST /report-template-versions/:id/publish 400s when changeSummary exceeds 500 characters", async (t) => {
  const { call } = mount();
  const result = await call("POST", "/report-template-versions/v-1/publish", { changeSummary: "x".repeat(501) });
  assert.equal(result.status, 400);
});

test("POST /report-template-versions/:id/publish 404s when the version is missing", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount();
  const result = await call("POST", "/report-template-versions/missing/publish", CHANGE_SUMMARY);
  assert.equal(result.status, 404);
});

test("POST /report-template-versions/:id/publish denies a member without reports.template.manage", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", version_number: 1, is_published: false }];
    }
    return [];
  });
  const { call } = mount({ memberships: MEMBER });
  const result = await call("POST", "/report-template-versions/v-1/publish", CHANGE_SUMMARY);
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
});

test("POST /report-template-versions/:id/publish denies a template manager who lacks reports.publish", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", version_number: 1, is_published: false }];
    }
    return [];
  });
  const { call } = mount({ memberships: MANAGER_NO_PUBLISH });
  const result = await call("POST", "/report-template-versions/v-1/publish", CHANGE_SUMMARY);
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
});

test("POST /report-template-versions/:id/publish rejects an already-published version with 409", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-1", facility_id: "fac-1", template_id: "t-1", version_number: 1, is_published: true }];
    }
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/report-template-versions/v-1/publish", CHANGE_SUMMARY);
  assert.equal(result.status, 409);
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
});

test("POST /report-template-versions/:id/publish happy path flips is_published and the template's active_version/status", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-2", facility_id: "fac-1", template_id: "t-1", version_number: 2, is_published: false }];
    }
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_template_versions" && method === "PATCH") {
      return [{ id: "v-2", is_published: true }];
    }
    if (table === "report_templates" && method === "PATCH") {
      return [{ id: "t-1", active_version: 2, status: "published" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/report-template-versions/v-2/publish", CHANGE_SUMMARY);
  assert.equal(result.status, 200);
  const versionPatch = captured.find((c) => c.table === "report_template_versions" && c.method === "PATCH");
  const templatePatch = captured.find((c) => c.table === "report_templates" && c.method === "PATCH");
  assert.equal(versionPatch.url.searchParams.get("id"), "eq.v-2");
  assert.deepEqual(versionPatch.body, { is_published: true });
  assert.equal(templatePatch.url.searchParams.get("id"), "eq.t-1");
  assert.equal(templatePatch.body.active_version, 2);
  assert.equal(templatePatch.body.status, "published");
  assert.equal(result.payload.version.id, "v-2");
  assert.equal(result.payload.template.id, "t-1");
});

// --- DR-26: governance (templatePublishRequiresApproval) --------------------
// modules/organization_module_settings/facility_module_overrides are stubbed
// so loadModuleConfig resolves daily_reports.templatePublishRequiresApproval
// = true from a facility override, matching how the real registry layers
// resolve (src/lib/http/module-config.mjs).
function stubGovernanceOn(t, extra) {
  return stubFetch(t, (table, method, url) => {
    if (table === "modules" && method === "GET") return [{ id: "mod-daily-reports", code: "daily_reports" }];
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", organization_id: "org-1" }];
    if (table === "organization_module_settings" && method === "GET") return [];
    if (table === "facility_module_overrides" && method === "GET") {
      return [{ config_patch_jsonb: { "daily_reports.templatePublishRequiresApproval": true } }];
    }
    return extra ? extra(table, method, url) : [];
  });
}

test("POST /report-template-versions/:id/publish stages a change request instead of publishing when governance is on", async (t) => {
  const captured = stubGovernanceOn(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-2", facility_id: "fac-1", template_id: "t-1", version_number: 2, is_published: false }];
    }
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1", active_version: 1, status: "published" }];
    if (table === "admin_change_requests" && method === "POST") {
      return [
        {
          id: "cr-1",
          facility_id: "fac-1",
          entity_table: "report_template_versions",
          entity_id: "v-2",
          status: "draft",
          requested_by: "user-1",
          change_summary: "Publishing the revised opening checklist."
        }
      ];
    }
    if (table === "admin_change_requests" && method === "PATCH") {
      return [{ id: "cr-1", status: "pending_review", requested_by: "user-1" }];
    }
    return [];
  });
  const { call } = mount();
  const result = await call("POST", "/report-template-versions/v-2/publish", CHANGE_SUMMARY);
  assert.equal(result.status, 202);
  assert.equal(result.payload.changeRequest.status, "pending_review");
  // Never actually published under governance.
  assert.ok(!captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
  assert.ok(!captured.some((c) => c.table === "report_templates" && c.method === "PATCH"));
  const inserted = captured.find((c) => c.table === "admin_change_requests" && c.method === "POST");
  assert.equal(inserted.body[0].entity_table, "report_template_versions");
  assert.equal(inserted.body[0].entity_id, "v-2");
  assert.equal(inserted.body[0].change_summary, "Publishing the revised opening checklist.");
});

test("POST /report-template-versions/:id/publish/approve rejects self-approval with 409", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-2", facility_id: "fac-1", template_id: "t-1", version_number: 2, is_published: false }];
    }
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "pending_review", requested_by: "user-1" }];
    }
    return [];
  });
  const { call } = mount({ userId: "user-1" });
  const result = await call("POST", "/report-template-versions/v-2/publish/approve");
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /self-approved/);
});

test("POST /report-template-versions/:id/publish/approve 404s when there is no pending request", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-2", facility_id: "fac-1", template_id: "t-1", version_number: 2, is_published: false }];
    }
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "admin_change_requests" && method === "GET") return [];
    return [];
  });
  const { call } = mount({ userId: "user-2" });
  const result = await call("POST", "/report-template-versions/v-2/publish/approve");
  assert.equal(result.status, 404);
});

test("POST /report-template-versions/:id/publish/approve by a different actor publishes and marks the request published", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_template_versions" && method === "GET") {
      return [{ id: "v-2", facility_id: "fac-1", template_id: "t-1", version_number: 2, is_published: false }];
    }
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "admin_change_requests" && method === "GET") {
      return [{ id: "cr-1", facility_id: "fac-1", status: "pending_review", requested_by: "user-1" }];
    }
    if (table === "admin_change_requests" && method === "PATCH") {
      return [{ id: "cr-1", status: "approved", requested_by: "user-1", reviewed_by: "user-2" }];
    }
    if (table === "report_template_versions" && method === "PATCH") return [{ id: "v-2", is_published: true }];
    if (table === "report_templates" && method === "PATCH") return [{ id: "t-1", active_version: 2, status: "published" }];
    return [];
  });
  const { call } = mount({ userId: "user-2" });
  const result = await call("POST", "/report-template-versions/v-2/publish/approve");
  assert.equal(result.status, 200);
  assert.equal(result.payload.version.id, "v-2");
  assert.equal(result.payload.template.id, "t-1");
  assert.ok(captured.some((c) => c.table === "report_template_versions" && c.method === "PATCH"));
  assert.ok(captured.some((c) => c.table === "report_templates" && c.method === "PATCH"));
  const patches = captured.filter((c) => c.table === "admin_change_requests" && c.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.equal(patches[0].body.status, "approved");
  assert.equal(patches[1].body.status, "published");
});

// --- DR-26: sandbox flag -----------------------------------------------------

test("PATCH /report-templates/:id updates sandbox", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    if (table === "report_templates" && method === "PATCH") return [{ id: "t-1", sandbox: true }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-templates/t-1", { sandbox: true });
  assert.equal(result.status, 200);
  const patch = captured.find((c) => c.table === "report_templates" && c.method === "PATCH");
  assert.equal(patch.body.sandbox, true);
});

test("PATCH /report-templates/:id rejects a non-boolean sandbox", async (t) => {
  stubFetch(t, (table, method) => {
    if (table === "report_templates" && method === "GET") return [{ id: "t-1", facility_id: "fac-1" }];
    return [];
  });
  const { call } = mount();
  const result = await call("PATCH", "/report-templates/t-1", { sandbox: "yes" });
  assert.equal(result.status, 400);
});
