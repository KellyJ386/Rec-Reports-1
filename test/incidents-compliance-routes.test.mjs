import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";
import { registerIncidentComplianceRoutes } from "../src/lib/http/incidents-compliance-routes.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MANAGER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.manage"] }];
const REVIEWER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read", "incidents.review"] }];
const READER = [{ facilityId: "fac-1", status: "active", permissions: ["incidents.read"] }];
const OUTSIDER = [{ facilityId: "fac-2", status: "active", permissions: ["incidents.read", "incidents.manage"] }];

const INCIDENT = {
  id: "inc-1",
  facility_id: "fac-1",
  status: "under_review",
  severity: "high",
  report_type: "accident",
  requires_osha_review: false
};

const SIGNATURE = {
  id: "sig-1",
  facility_id: "fac-1",
  incident_id: "inc-1",
  signer_user_id: "user-1",
  role: "supervisor",
  attestation_text: "I attest this is accurate.",
  signed_name: "Jamie Rivera",
  signature_image_path: null,
  signed_at: "2026-07-19T00:00:00Z"
};

const COMPLIANCE_CHECK = {
  id: "check-1",
  facility_id: "fac-1",
  incident_id: "inc-1",
  check_key: "evidence_complete",
  status: "pass",
  notes: null,
  checked_by: "user-1",
  checked_at: "2026-07-19T00:00:00Z"
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

function mount({ memberships = MANAGER, userId = "user-1", env = {} } = {}) {
  const router = createRouter();
  const sent = [];
  const client = createClient({ url: "https://example.supabase.co", key: "service-key" });
  const authenticate = async () => ({ claims: { sub: userId }, client, memberships, error: null });
  const sendJson = (response, status, payload) => sent.push({ status, payload });
  const readBody = async (request) => request.__body ?? "{}";
  registerIncidentComplianceRoutes(router, { authenticate, sendJson, readBody });
  async function call(method, path, body) {
    const { handler, params } = router.match({ method, url: path });
    assert.ok(handler, `no route matched ${method} ${path}`);
    const request = { url: path, __body: body === undefined ? undefined : JSON.stringify(body) };
    await handler(request, {}, { env, params });
    return sent[sent.length - 1];
  }
  return { call };
}

const PATH = "/facilities/fac-1/incidents/inc-1";

// --- GET .../signatures --------------------------------------------------

test("GET signatures denies a non-member of the facility with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", `${PATH}/signatures`);
  assert.equal(result.status, 403);
});

test("GET signatures 404s when the incident does not belong to the URL's facility", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [{ ...INCIDENT, facility_id: "fac-2" }] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("GET", `${PATH}/signatures`);
  assert.equal(result.status, 404);
});

test("GET signatures returns the list for a reader", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_signatures") return [SIGNATURE];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", `${PATH}/signatures`);
  assert.equal(result.status, 200);
  assert.equal(result.payload.length, 1);
  assert.equal(result.payload[0].id, "sig-1");
});

// --- POST .../signatures ---------------------------------------------------

test("POST signatures validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", `${PATH}/signatures`, { role: "supervisor" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST signatures rejects an unknown role", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/signatures`, {
    role: "ceo",
    attestationText: "I attest",
    signedName: "Someone"
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.errors[0], /role must be one of/);
});

test("POST signatures rejects an attestation over 2000 characters", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/signatures`, {
    role: "witness",
    attestationText: "a".repeat(2001),
    signedName: "Someone"
  });
  assert.equal(result.status, 400);
});

test("POST signatures denies a reader without incidents.manage or incidents.review", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: READER });
  const result = await call("POST", `${PATH}/signatures`, {
    role: "witness",
    attestationText: "I attest",
    signedName: "Someone"
  });
  assert.equal(result.status, 403);
});

test("POST signatures rejects a signatureImagePath outside the incident's own facility with 400", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/signatures`, {
    role: "witness",
    attestationText: "I attest",
    signedName: "Someone",
    signatureImagePath: "facilities/fac-2/incidents/inc-1/x.png"
  });
  assert.equal(result.status, 400);
});

// L1 (security review): the path must be bound to THIS signature's own
// incident, not just the facility+module -- a same-facility,
// "incidents"-module path naming a DIFFERENT incident id must now be
// rejected, where the module-only check previously admitted it.
// assertPathInFacility requires a genuinely UUID-shaped facilityId (it
// throws on "fac-1" before ever looking at the path), so these two tests
// use their own UUID-shaped facility/membership/incident fixtures rather
// than the file's usual human-readable "fac-1" -- everything else about
// the request is identical to the tests around them.
const UUID_FACILITY_ID = "11111111-1111-1111-1111-111111111111";
const UUID_INCIDENT = { ...INCIDENT, facility_id: UUID_FACILITY_ID };
const UUID_MANAGER = [
  { facilityId: UUID_FACILITY_ID, status: "active", permissions: ["incidents.read", "incidents.manage"] }
];
const UUID_PATH = `/facilities/${UUID_FACILITY_ID}/incidents/inc-1`;

test("POST signatures rejects a signatureImagePath under a DIFFERENT incident in the same facility/module with 400", async (t) => {
  stubFetch(t, (table) => (table === "incident_reports" ? [UUID_INCIDENT] : []));
  const { call } = mount({ memberships: UUID_MANAGER });
  const result = await call("POST", `${UUID_PATH}/signatures`, {
    role: "witness",
    attestationText: "I attest",
    signedName: "Someone",
    signatureImagePath: `facilities/${UUID_FACILITY_ID}/incidents/inc-OTHER/x.png`
  });
  assert.equal(result.status, 400);
});

test("POST signatures accepts a signatureImagePath scoped to this incident's own id", async (t) => {
  const scopedPath = `facilities/${UUID_FACILITY_ID}/incidents/inc-1/x.png`;
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [UUID_INCIDENT];
    if (table === "incident_signatures" && method === "POST") {
      return [{ ...SIGNATURE, facility_id: UUID_FACILITY_ID, role: "witness", signature_image_path: scopedPath }];
    }
    return [];
  });
  const { call } = mount({ memberships: UUID_MANAGER, userId: "user-9" });
  const result = await call("POST", `${UUID_PATH}/signatures`, {
    role: "witness",
    attestationText: "I attest",
    signedName: "Someone",
    signatureImagePath: scopedPath
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_signatures" && c.method === "POST");
  assert.equal(insert.body[0].signature_image_path, scopedPath);
});

test("POST signatures happy path (non-supervisor role) inserts a signature, writes one audit event, and does not touch compliance checks", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_signatures" && method === "POST") return [{ ...SIGNATURE, role: "witness" }];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER, userId: "user-9" });
  const result = await call("POST", `${PATH}/signatures`, {
    role: "witness",
    attestationText: "I saw the whole thing.",
    signedName: "Jamie Rivera"
  });
  assert.equal(result.status, 201);
  const insert = captured.find((c) => c.table === "incident_signatures" && c.method === "POST");
  assert.equal(insert.body[0].signer_user_id, "user-9");
  assert.equal(insert.body[0].role, "witness");
  assert.equal(insert.body[0].facility_id, "fac-1");
  assert.equal(insert.body[0].incident_id, "inc-1");
  assert.ok(!captured.some((c) => c.table === "incident_compliance_checks"));
  const auditInserts = captured.filter((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInserts.length, 1);
  assert.equal(auditInserts[0].body[0].event_type, "incident.signed");
});

test("POST signatures with role='supervisor' also upserts a supervisor_signoff='pass' compliance check and writes two audit events", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_signatures" && method === "POST") return [SIGNATURE];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/signatures`, {
    role: "supervisor",
    attestationText: "I attest this is accurate.",
    signedName: "Jamie Rivera"
  });
  assert.equal(result.status, 201);
  const checkInsert = captured.find((c) => c.table === "incident_compliance_checks" && c.method === "POST");
  assert.ok(checkInsert, "expected an incident_compliance_checks upsert");
  assert.equal(checkInsert.body[0].check_key, "supervisor_signoff");
  assert.equal(checkInsert.body[0].status, "pass");
  assert.equal(checkInsert.url.searchParams.get("on_conflict"), "incident_id,check_key");
  const auditInserts = captured.filter((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(auditInserts.length, 2);
  assert.equal(auditInserts[0].body[0].event_type, "incident.signed");
  assert.equal(auditInserts[1].body[0].event_type, "incident.compliance_check_recorded");
});

// --- GET .../compliance-checks -----------------------------------------------

test("GET compliance-checks denies a non-reader with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", `${PATH}/compliance-checks`);
  assert.equal(result.status, 403);
});

test("GET compliance-checks returns the list for a reader", async (t) => {
  stubFetch(t, (table) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_compliance_checks") return [COMPLIANCE_CHECK];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", `${PATH}/compliance-checks`);
  assert.equal(result.status, 200);
  assert.equal(result.payload[0].check_key, "evidence_complete");
});

// L5 (security review): matches the closure gate's own route-layer
// pre-check (incidents-routes.mjs) filtering out soft-deleted rows, so a
// caller here never sees a check the closure gate itself already ignores.
test("GET compliance-checks filters out soft-deleted rows (deleted_at is.null)", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_compliance_checks") return [COMPLIANCE_CHECK];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", `${PATH}/compliance-checks`);
  assert.equal(result.status, 200);
  const query = captured.find((c) => c.table === "incident_compliance_checks");
  assert.equal(query.url.searchParams.get("deleted_at"), "is.null");
});

// --- POST .../compliance-checks ----------------------------------------------

test("POST compliance-checks validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", `${PATH}/compliance-checks`, { checkKey: "not_a_real_key", status: "pass" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST compliance-checks rejects an unknown status", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/compliance-checks`, { checkKey: "evidence_complete", status: "maybe" });
  assert.equal(result.status, 400);
});

test("POST compliance-checks pass/fail: incidents.manage holder is allowed", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_compliance_checks" && method === "POST") return [{ ...COMPLIANCE_CHECK, status: "fail" }];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/compliance-checks`, { checkKey: "evidence_complete", status: "fail" });
  assert.equal(result.status, 200);
  const insert = captured.find((c) => c.table === "incident_compliance_checks" && c.method === "POST");
  assert.equal(insert.body[0].status, "fail");
  assert.equal(insert.body[0].checked_by, "user-1");
});

test("POST compliance-checks waive: incidents.manage-only holder (no incidents.review) is denied 403, and no write occurs", async (t) => {
  const captured = stubFetch(t, (table) => (table === "incident_reports" ? [INCIDENT] : []));
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/compliance-checks`, { checkKey: "evidence_complete", status: "waived" });
  assert.equal(result.status, 403);
  assert.ok(!captured.some((c) => c.table === "incident_compliance_checks"));
});

test("POST compliance-checks waive: incidents.review holder is allowed", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_compliance_checks" && method === "POST") return [{ ...COMPLIANCE_CHECK, status: "waived" }];
    return [];
  });
  const { call } = mount({ memberships: REVIEWER });
  const result = await call("POST", `${PATH}/compliance-checks`, {
    checkKey: "evidence_complete",
    status: "waived",
    notes: "documented in the case file"
  });
  assert.equal(result.status, 200);
  const insert = captured.find((c) => c.table === "incident_compliance_checks" && c.method === "POST");
  assert.equal(insert.body[0].status, "waived");
  const audit = captured.find((c) => c.table === "incident_audit_events" && c.method === "POST");
  assert.equal(audit.body[0].event_payload.waived, true);
});

test("POST compliance-checks upserts on (incident_id, check_key)", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "incident_reports") return [INCIDENT];
    if (table === "incident_compliance_checks" && method === "POST") return [COMPLIANCE_CHECK];
    return [];
  });
  const { call } = mount({ memberships: MANAGER });
  await call("POST", `${PATH}/compliance-checks`, { checkKey: "evidence_complete", status: "pass" });
  const insert = captured.find((c) => c.table === "incident_compliance_checks" && c.method === "POST");
  assert.equal(insert.url.searchParams.get("on_conflict"), "incident_id,check_key");
});

// --- GET .../incidents/osha-decision-tree ------------------------------------

test("GET osha-decision-tree denies a non-reader with 403", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: OUTSIDER });
  const result = await call("GET", "/facilities/fac-1/incidents/osha-decision-tree");
  assert.equal(result.status, 403);
});

test("GET osha-decision-tree returns the effective tree (registry default when unconfigured)", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return [{ id: "mod-incidents", code: "incidents" }];
    if (table === "facilities") return [{ id: "fac-1", organization_id: null }];
    if (table === "facility_module_overrides") return [];
    return [];
  });
  const { call } = mount({ memberships: READER });
  const result = await call("GET", "/facilities/fac-1/incidents/osha-decision-tree");
  assert.equal(result.status, 200);
  assert.equal(result.payload.tree.start, "fatality");
  assert.ok(result.payload.tree.nodes.fatality);
});

// --- POST .../osha-evaluation ------------------------------------------------

function stubOshaModuleConfig(respond) {
  return (table, method, url) => {
    if (table === "modules") return [{ id: "mod-incidents", code: "incidents" }];
    if (table === "facilities") return [{ id: "fac-1", organization_id: null }];
    if (table === "facility_module_overrides") return [];
    return respond(table, method, url);
  };
}

test("POST osha-evaluation validates shape before guarding (400, no fetch)", async (t) => {
  const captured = stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", `${PATH}/osha-evaluation`, { answers: "not an object" });
  assert.equal(result.status, 400);
  assert.equal(captured.length, 0);
});

test("POST osha-evaluation denies a reader without incidents.manage or incidents.review", async (t) => {
  stubFetch(t, () => []);
  const { call } = mount({ memberships: READER });
  const result = await call("POST", `${PATH}/osha-evaluation`, { answers: { fatality: "yes" } });
  assert.equal(result.status, 403);
});

test("POST osha-evaluation fatality path: recordable, sets requires_osha_review via the amendment RPC (non-draft incident), creates a regulatory-timer follow-up", async (t) => {
  const captured = stubFetch(
    t,
    stubOshaModuleConfig((table, method) => {
      if (table === "incident_reports") return [INCIDENT]; // status: under_review, requires_osha_review: false
      if (table === "incident_compliance_checks" && method === "POST") {
        return [{ id: "check-osha", check_key: "osha_recordability", status: "pass" }];
      }
      if (table === "rpc/apply_incident_amendment") {
        return { incident: { ...INCIDENT, requires_osha_review: true }, amendment: { id: "amend-1" } };
      }
      if (table === "incident_followup_actions" && method === "POST") {
        return [{ id: "fu-osha", action_type: "documentation", due_at: "2099-01-01T00:00:00.000Z" }];
      }
      return [];
    })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/osha-evaluation`, { answers: { fatality: "yes" } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.outcome, "recordable");
  assert.equal(result.payload.recordable, true);
  assert.equal(result.payload.incident.requires_osha_review, true);
  assert.ok(result.payload.followup, "expected a regulatory-timer follow-up to be created");

  const rpcCall = captured.find((c) => c.table === "rpc/apply_incident_amendment");
  assert.ok(rpcCall, "expected the amendment RPC to be called for a non-draft incident");
  assert.equal(rpcCall.body.changes.requires_osha_review, true);
  assert.match(rpcCall.body.reason, /OSHA decision tree/);

  const checkInsert = captured.find((c) => c.table === "incident_compliance_checks" && c.method === "POST");
  assert.equal(checkInsert.body[0].check_key, "osha_recordability");
  assert.equal(checkInsert.body[0].status, "pass");

  const followupInsert = captured.find((c) => c.table === "incident_followup_actions" && c.method === "POST");
  assert.equal(followupInsert.body[0].action_type, "documentation");
  // dueAt is computed from the real clock (now + 8h, the fatality timer) --
  // assert it parses to roughly 8 hours out rather than pinning an exact
  // timestamp.
  const dueAtMs = new Date(followupInsert.body[0].due_at).getTime();
  const deltaHours = (dueAtMs - Date.now()) / (60 * 60 * 1000);
  assert.ok(deltaHours > 7.9 && deltaHours < 8.1, `expected ~8h out, got ${deltaHours}h`);

  const auditTypes = captured
    .filter((c) => c.table === "incident_audit_events" && c.method === "POST")
    .map((c) => c.body[0].event_type);
  assert.deepEqual(auditTypes, ["incident.osha_evaluated", "incident.amended", "incident.followup_created"]);
});

test("POST osha-evaluation on a draft incident sets requires_osha_review via a plain UPDATE, not the amendment RPC", async (t) => {
  const DRAFT_INCIDENT = { ...INCIDENT, status: "draft" };
  const captured = stubFetch(
    t,
    stubOshaModuleConfig((table, method) => {
      if (table === "incident_reports") {
        if (method === "PATCH") return [{ ...DRAFT_INCIDENT, requires_osha_review: true }];
        return [DRAFT_INCIDENT];
      }
      if (table === "incident_compliance_checks" && method === "POST") return [{ status: "pass" }];
      if (table === "incident_followup_actions" && method === "POST") return [{ id: "fu-1" }];
      return [];
    })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/osha-evaluation`, { answers: { fatality: "yes" } });
  assert.equal(result.status, 200);
  assert.ok(!captured.some((c) => c.table === "rpc/apply_incident_amendment"));
  const patch = captured.find((c) => c.table === "incident_reports" && c.method === "PATCH");
  assert.equal(patch.body.requires_osha_review, true);
});

test("POST osha-evaluation not-recordable path: no follow-up created, no requires_osha_review change", async (t) => {
  const captured = stubFetch(
    t,
    stubOshaModuleConfig((table, method) => {
      if (table === "incident_reports") return [INCIDENT];
      if (table === "incident_compliance_checks" && method === "POST") return [{ status: "pass" }];
      return [];
    })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/osha-evaluation`, {
    answers: { fatality: "no", hospitalization: "no", work_related: "no" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.outcome, "not_work_related");
  assert.equal(result.payload.recordable, false);
  assert.equal(result.payload.followup, null);
  assert.ok(!captured.some((c) => c.table === "incident_followup_actions"));
  assert.ok(!captured.some((c) => c.table === "rpc/apply_incident_amendment"));
});

test("POST osha-evaluation with insufficient answers records the compliance check as 'fail' (incomplete determination)", async (t) => {
  const captured = stubFetch(
    t,
    stubOshaModuleConfig((table, method) => {
      if (table === "incident_reports") return [INCIDENT];
      if (table === "incident_compliance_checks" && method === "POST") return [{ status: "fail" }];
      return [];
    })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/osha-evaluation`, { answers: {} });
  assert.equal(result.status, 200);
  assert.equal(result.payload.outcome, "needs_more_info");
  const checkInsert = captured.find((c) => c.table === "incident_compliance_checks" && c.method === "POST");
  assert.equal(checkInsert.body[0].status, "fail");
});

test("POST osha-evaluation does not re-amend when requires_osha_review is already true", async (t) => {
  const ALREADY_FLAGGED = { ...INCIDENT, requires_osha_review: true };
  const captured = stubFetch(
    t,
    stubOshaModuleConfig((table, method) => {
      if (table === "incident_reports") return [ALREADY_FLAGGED];
      if (table === "incident_compliance_checks" && method === "POST") return [{ status: "pass" }];
      if (table === "incident_followup_actions" && method === "POST") return [{ id: "fu-1" }];
      return [];
    })
  );
  const { call } = mount({ memberships: MANAGER });
  const result = await call("POST", `${PATH}/osha-evaluation`, { answers: { fatality: "yes" } });
  assert.equal(result.status, 200);
  assert.ok(!captured.some((c) => c.table === "rpc/apply_incident_amendment"));
  assert.ok(!captured.some((c) => c.table === "incident_reports" && c.method === "PATCH"));
});
