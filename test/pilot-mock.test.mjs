import test from "node:test";
import assert from "node:assert/strict";
import {
  createPilotStore,
  MANAGER_PERMISSIONS,
  signIn,
  meResponse,
  listReportTemplates,
  createReportSubmission,
  listReports,
  getReportDetail,
  submitReportSubmission,
  addReportAttachment,
  reportsCompliance,
  listIncidents,
  createIncident,
  submitIncident,
  addPerson,
  listPeople,
  addStatement,
  listStatements,
  acknowledgeMessage,
  listAcknowledgements,
  listMessages,
  listShiftAssignments,
  search,
  routeMock
} from "../scripts/lib/pilot-mock.mjs";

const NOW = new Date("2026-09-07T12:00:00.000Z");

// --- seed ------------------------------------------------------------------

test("createPilotStore seeds a self-consistent facility: templates, employees, tiles' source data all agree", () => {
  const store = createPilotStore({ now: NOW });
  assert.equal(store.employees.some((e) => e.id === store.employeeId), true, "the caller's own employeeId must be a real employee row");
  assert.equal(listReportTemplates(store).length, 1);
  assert.equal(listReportTemplates(store)[0].status, "published");
  assert.equal(listMessages(store, { status: "published" }).filter((m) => m.is_required_ack).length, 1);
  // The pre-seeded shift assignment exists from the moment the store is
  // created -- nothing in this test creates it -- and points at the
  // caller's own employeeId, matching "an assignment that exists only in
  // the mock (never made in this session)".
  const period = store.schedulePeriods[0];
  const assignments = listShiftAssignments(store, period.id);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].employee_id, store.employeeId);
  assert.equal(assignments[0].status, "approved");
});

test("meResponse exposes a manager-level (non-admin.*) permission set and the employeeId", () => {
  const store = createPilotStore({ now: NOW });
  const me = meResponse(store);
  assert.equal(me.platformAdmin, false);
  assert.equal(me.facilities.length, 1);
  assert.deepEqual(me.facilities[0].permissions, [...MANAGER_PERMISSIONS]);
  assert.equal(me.facilities[0].employeeId, store.employeeId);
  assert.equal(
    me.facilities[0].permissions.some((code) => code.startsWith("admin.")),
    false,
    "a manager permission set must hold no admin.* code, or the sign-in page would land on /admin/ instead of /"
  );
});

test("signIn requires both email and password", () => {
  const store = createPilotStore({ now: NOW });
  const missing = signIn(store, { email: "a@b.com" });
  assert.equal(missing.status, 400);
  const ok = signIn(store, { email: "a@b.com", password: "x" });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.access_token);
});

// --- reports: create -> patch is irrelevant, submit -> compliance moves ----

test("creating and submitting a report is what moves the compliance count a later GET sees", () => {
  const store = createPilotStore({ now: NOW });
  const template = listReportTemplates(store)[0];
  const today = "2026-09-07";

  const before = reportsCompliance(store, { from: today, to: today });
  assert.equal(before.templates[0].submitted, 0);
  assert.equal(before.templates[0].missing, 1);

  const created = createReportSubmission(store, { templateId: template.id, reportDate: today, payload: {} });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "draft");

  const midCompliance = reportsCompliance(store, { from: today, to: today });
  assert.equal(midCompliance.templates[0].submitted, 0, "a draft must not count as submitted");

  const submitted = submitReportSubmission(store, created.json.id);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.status, "submitted");

  const after = reportsCompliance(store, { from: today, to: today });
  assert.equal(after.templates[0].submitted, 1);
  assert.equal(after.templates[0].missing, 0);

  // And the list route (what the "Recent submissions" panel reads) reflects
  // it too, without a second write.
  assert.equal(listReports(store, {}).find((r) => r.id === created.json.id).status, "submitted");
});

test("submitReportSubmission refuses a second submit (already submitted)", () => {
  const store = createPilotStore({ now: NOW });
  const template = listReportTemplates(store)[0];
  const created = createReportSubmission(store, { templateId: template.id, reportDate: "2026-09-07", payload: {} });
  submitReportSubmission(store, created.json.id);
  const second = submitReportSubmission(store, created.json.id);
  assert.equal(second.status, 409);
});

test("addReportAttachment records a storage path scoped under the facility/module/submission, retrievable by getReportDetail", () => {
  const store = createPilotStore({ now: NOW });
  const template = listReportTemplates(store)[0];
  const created = createReportSubmission(store, { templateId: template.id, reportDate: "2026-09-07", payload: {} });

  const attachment = addReportAttachment(store, created.json.id, {
    fieldKey: "evidence_photo",
    fileName: "pool.png",
    contentType: "image/png"
  });
  assert.equal(attachment.status, 201);
  assert.match(attachment.json.storage_path, new RegExp(`^facilities/${store.facilityId}/reports/${created.json.id}/`));

  const detail = getReportDetail(store, created.json.id);
  assert.equal(detail.json.attachments.length, 1);
  assert.equal(detail.json.attachments[0].id, attachment.json.id);
});

// --- incidents: create -> add person -> add statement -----------------------

test("an incident starts with no people, gains exactly the one added, and its statement history grows on add", () => {
  const store = createPilotStore({ now: NOW });
  assert.equal(listIncidents(store, {}).length, 0);

  const created = createIncident(store, {
    reportType: "incident",
    severity: "medium",
    occurredAt: "2026-09-07T10:00:00.000Z",
    locationText: "Pool Deck",
    summary: "Chemical fumes triggered a pool evacuation near the diving board."
  });
  assert.equal(created.status, 201);
  assert.match(created.json.incident_no, /^INC-\d{4}$/);
  assert.equal(listPeople(store, created.json.id).length, 0);

  const person = addPerson(store, created.json.id, { personRole: "witness", fullName: "Alex Morgan" });
  assert.equal(person.status, 201);
  const people = listPeople(store, created.json.id);
  assert.equal(people.length, 1);
  assert.equal(people[0].full_name, "Alex Morgan");
  assert.equal(people[0].person_role, "witness");

  assert.equal(listStatements(store, person.json.id).length, 0);
  const statement = addStatement(store, person.json.id, { statementText: "Witnessed chemical fumes near the diving board." });
  assert.equal(statement.status, 201);
  assert.equal(statement.json.version_no, 1);
  assert.equal(listStatements(store, person.json.id).length, 1);

  const submitted = submitIncident(store, created.json.id);
  assert.equal(submitted.json.status, "submitted");
  assert.equal(listIncidents(store, { status: "submitted" }).length, 1);
  assert.equal(listIncidents(store, { status: "draft" }).length, 0);
});

test("addPerson on an unknown incident 404s rather than silently creating a floating row", () => {
  const store = createPilotStore({ now: NOW });
  const result = addPerson(store, "no-such-incident", { personRole: "witness", fullName: "Nobody" });
  assert.equal(result.status, 404);
});

// --- communications: unacknowledged -> acknowledge -> stays acknowledged ---

test("a required-ack message is unacknowledged for the caller until acknowledgeMessage records it, idempotently", () => {
  const store = createPilotStore({ now: NOW });
  const [messageId] = [...store.messages.keys()];

  assert.equal(listAcknowledgements(store, messageId, { employeeId: "me" }).length, 0);

  const first = acknowledgeMessage(store, messageId, store.employeeId);
  assert.equal(first.status, 201);
  assert.equal(listAcknowledgements(store, messageId, { employeeId: "me" }).length, 1);

  // Acknowledging twice must not create a second row (mirrors the real
  // route's own idempotent-per-employee semantics) -- and "employeeId=me"
  // must resolve to the SAME row a raw employeeId lookup does, since that's
  // exactly what the client's own seedAckStateForVisibleMessages relies on
  // after a reload discards any client-side "I just acked this" flag.
  const second = acknowledgeMessage(store, messageId, store.employeeId);
  assert.equal(second.status, 200);
  assert.equal(listAcknowledgements(store, messageId, { employeeId: "me" }).length, 1);
  assert.deepEqual(
    listAcknowledgements(store, messageId, { employeeId: store.employeeId }),
    listAcknowledgements(store, messageId, { employeeId: "me" })
  );
});

// --- search: only finds what exists in the CURRENT store -------------------

test("search finds nothing for an incident's distinctive word until that incident is created, then finds it", () => {
  const store = createPilotStore({ now: NOW });
  assert.deepEqual(search(store, "evacuation").results, {});

  createIncident(store, {
    reportType: "incident",
    severity: "medium",
    occurredAt: "2026-09-07T10:00:00.000Z",
    locationText: "Pool Deck",
    summary: "Chemical fumes triggered a pool evacuation near the diving board."
  });

  const result = search(store, "evacuation");
  assert.equal(result.results.incidents.length, 1);
  assert.equal(result.results.workOrders, undefined, "a leg with no matches must be omitted entirely, not present-but-empty");
});

// --- routeMock: the HTTP-shaped dispatcher over the same state -------------

test("routeMock POST /facilities/:id/incidents then GET the same incident's people round-trips through the dispatcher", () => {
  const store = createPilotStore({ now: NOW });

  const created = routeMock(store, {
    method: "POST",
    pathname: `/facilities/${store.facilityId}/incidents`,
    searchParams: new URLSearchParams(),
    body: {
      reportType: "incident",
      severity: "low",
      occurredAt: "2026-09-07T10:00:00.000Z",
      locationText: "Pool Deck",
      summary: "Minor slip near the entrance."
    }
  });
  assert.equal(created.status, 201);

  const addPersonResult = routeMock(store, {
    method: "POST",
    pathname: `/facilities/${store.facilityId}/incidents/${created.json.id}/people`,
    searchParams: new URLSearchParams(),
    body: { personRole: "staff", fullName: "Sam Lee" }
  });
  assert.equal(addPersonResult.status, 201);

  const peopleList = routeMock(store, {
    method: "GET",
    pathname: `/facilities/${store.facilityId}/incidents/${created.json.id}/people`,
    searchParams: new URLSearchParams(),
    body: undefined
  });
  assert.equal(peopleList.status, 200);
  assert.equal(peopleList.json.length, 1);
  assert.equal(peopleList.json[0].full_name, "Sam Lee");
});

test("routeMock POST /messages/:id/acknowledge then GET .../acknowledgements?employeeId=me agree, mirroring app.js's own seed call", () => {
  const store = createPilotStore({ now: NOW });
  const [messageId] = [...store.messages.keys()];

  const ackResult = routeMock(store, {
    method: "POST",
    pathname: `/messages/${messageId}/acknowledge`,
    searchParams: new URLSearchParams(),
    body: {}
  });
  assert.equal(ackResult.status, 201);

  const params = new URLSearchParams({ employeeId: "me" });
  const listed = routeMock(store, {
    method: "GET",
    pathname: `/facilities/${store.facilityId}/messages/${messageId}/acknowledgements`,
    searchParams: params,
    body: undefined
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.length, 1);
});

test("routeMock falls back to an empty list/object for a GET/write it does not specifically handle, never throwing", () => {
  const store = createPilotStore({ now: NOW });
  const getResult = routeMock(store, {
    method: "GET",
    pathname: "/facilities/some-facility/departments-that-do-not-exist",
    searchParams: new URLSearchParams(),
    body: undefined
  });
  assert.equal(getResult.status, 200);
  assert.deepEqual(getResult.json, []);

  const postResult = routeMock(store, {
    method: "POST",
    pathname: "/some/unhandled/write",
    searchParams: new URLSearchParams(),
    body: {}
  });
  assert.equal(postResult.status, 200);
  assert.deepEqual(postResult.json, {});
});
