// Wave 2 exit-gate check (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md
// §Verification, "Wave 2"): a small, STATEFUL in-memory backend for the
// pilot-journey Playwright script (scripts/pilot-journey.mjs). Unlike
// scripts/a11y-check.mjs's mockApiRoutes (every GET answers a canned "[]",
// every write a canned "{}" -- fine for an accessibility sweep that never
// checks a response body) this mock actually remembers what the journey
// does: submitting a report appends to the reports list a later GET sees;
// acknowledging a message removes it from a later "unacknowledged" count;
// a shift assignment seeded at startup (never created by the journey
// itself) is still there after a reload. That's the whole point of this
// file -- "a POST must change what later GETs return" (the task's own
// words) -- so every write below mutates `store` in place and every read
// derives its answer from the CURRENT store, never a snapshot taken at
// startup.
//
// Everything here is pure data-in/data-out (no `fetch`, no Playwright, no
// `document`) so createPilotStore()'s seed and every exported mutator/query
// can be unit-tested directly under node:test (see
// test/pilot-mock.test.mjs) -- routeMock (the HTTP-shaped dispatcher
// scripts/pilot-journey.mjs's page.route() handler calls into) is the only
// piece that knows about method/pathname/query-string shapes; the state
// transitions themselves are tested without any of that HTTP plumbing.
//
// Response field names (snake_case row shapes, `facility_id`, `report_date`,
// ...) deliberately mirror what src/lib/http/*-routes.mjs actually returns
// (read from the route files, not guessed) -- src/public/js/app.js reads
// these fields directly off fetch responses with no server-side renaming,
// so a mock that used different names would validate nothing.

import { randomUUID } from "node:crypto";
import { weekBoundsFor } from "../../src/public/js/schedule-board.mjs";

// Credentials the pilot journey signs in with. The mock's /auth/sign-in
// accepts any email/password (there's no real Supabase Auth behind it to
// validate against -- see this file's header) but the journey should still
// look like a real sign-in rather than posting empty strings.
export const PILOT_EMAIL = "pilot.manager@example.test";
export const PILOT_PASSWORD = "correct-horse-battery-staple";

// A manager-level permission set (task requirement: "quick actions present
// for a manager-level permission set"): every code home-dashboard.mjs's
// quick actions/tiles check, plus the write/review codes each panel's own
// create/detail actions gate on, all verified against src/lib/permissions.mjs
// (every one of these codes exists there). Deliberately NOT platformAdmin --
// that bypasses hasPerm() entirely (app.js's own comment on hasPerm) and
// would prove nothing about a real facility membership's gating.
export const MANAGER_PERMISSIONS = Object.freeze([
  "reports.create",
  "reports.read",
  "reports.submit",
  "incidents.manage",
  "incidents.read",
  "incidents.review",
  "incidents.tasks.create",
  "work_orders.manage",
  "work_orders.read",
  "communications.read",
  "communications.publish",
  "schedule.read",
  "schedule.manage",
  "schedule.publish"
]);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

// --- Store -------------------------------------------------------------

// Builds a fresh, self-consistent seed: one facility, one manager user with
// an employee row in it, one published report template (with a text field
// and a photo field, so the journey can fill one and attach the other), one
// open incident-free facility (the journey creates the incident itself, so
// the "Open incidents" tile's 0 -> 1 transition is observable), one
// required-ack message nobody has acknowledged yet, one open work order
// assigned to the caller, one schedule period for the CURRENT week with one
// shift already assigned to the caller (never created by the journey --
// this is what step 6 checks survives a reload), and one certification
// expiring inside the 30-day window home-dashboard.mjs's tile checks.
// `now` is injectable so tests (and the journey itself) can pin "today"
// instead of racing the real clock at a day boundary.
export function createPilotStore({ now = new Date() } = {}) {
  const facilityId = "fac-pilot-1";
  const userId = "user-pilot-manager";
  const employeeId = "emp-pilot-me";
  const otherEmployeeId = "emp-pilot-other";
  const templateId = "tmpl-pilot-pool-chem";
  const versionId = "tmpl-pilot-pool-chem-v1";
  const today = isoDate(now);
  const { weekStartDate, weekEndDate } = weekBoundsFor(today);
  const periodId = "sp-pilot-current-week";
  const shiftId = "shift-pilot-today";
  const assignmentId = "sa-pilot-preseeded";
  const channelId = "chan-pilot-announcements";
  const messageId = "msg-pilot-required-ack";
  const workOrderId = "wo-pilot-open";
  const certId = "cert-pilot-expiring";

  const inTenDays = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const inThreeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const shiftStart = `${today}T13:00:00.000Z`;
  const shiftEnd = `${today}T17:00:00.000Z`;

  return {
    now,
    facilityId,
    userId,
    employeeId,
    email: PILOT_EMAIL,
    facility: { id: facilityId, name: "Sunset Recreation Center", organizationId: "org-pilot-1", organizationName: "Riverside Parks & Rec" },

    reportTemplates: new Map([
      [
        templateId,
        {
          id: templateId,
          facility_id: facilityId,
          department_id: null,
          code: "pool_chem_log",
          name: "Pool Chemical Log",
          description: "Daily chlorine/pH readings and any corrective action taken.",
          status: "published",
          active_version: 1,
          created_at: nowIso(),
          updated_at: nowIso()
        }
      ]
    ]),
    reportVersions: new Map([
      [
        versionId,
        {
          id: versionId,
          template_id: templateId,
          version_number: 1,
          schema_json: {
            sections: [
              {
                title: "Readings",
                fields: [
                  { key: "notes", label: "Notes", type: "textarea", required: true },
                  { key: "evidence_photo", label: "Evidence photo", type: "photo", required: false }
                ]
              }
            ]
          }
        }
      ]
    ]),
    // templateId -> its one published version's id, so create/detail routes
    // never have to scan reportVersions by template_id.
    activeVersionByTemplate: new Map([[templateId, versionId]]),

    reportSubmissions: new Map(),
    reportAttachments: new Map(), // submissionId -> [] rows

    incidents: new Map(),
    incidentPeople: new Map(), // incidentId -> [] rows
    incidentStatements: new Map(), // personId -> [] rows

    employees: [
      {
        id: employeeId,
        facility_id: facilityId,
        user_id: userId,
        first_name: "Jordan",
        last_name: "Rivera",
        employee_no: "E-1001",
        status: "active"
      },
      {
        id: otherEmployeeId,
        facility_id: facilityId,
        user_id: "user-pilot-other",
        first_name: "Casey",
        last_name: "Nguyen",
        employee_no: "E-1002",
        status: "active"
      }
    ],

    workOrders: new Map([
      [
        workOrderId,
        {
          id: workOrderId,
          facility_id: facilityId,
          title: "Replace pool filter cartridge",
          description: "Filter pressure gauge reading high; swap cartridge before Saturday.",
          status: "open",
          priority: "medium",
          assigned_to_employee_id: employeeId,
          due_at: inThreeDays,
          created_at: nowIso(),
          updated_at: nowIso()
        }
      ]
    ]),

    channels: [{ id: channelId, facility_id: facilityId, name: "Facility Announcements", channel_type: "broadcast" }],
    messages: new Map([
      [
        messageId,
        {
          id: messageId,
          facility_id: facilityId,
          channel_id: channelId,
          author_employee_id: otherEmployeeId,
          message_type: "broadcast",
          subject: "Pool closure safety briefing",
          body_text: "All lifeguards must review the revised emergency-action plan before Friday's shift.",
          priority: "urgent",
          is_required_ack: true,
          ack_due_at: inThreeDays,
          published_at: nowIso(),
          created_at: nowIso(),
          updated_at: nowIso()
        }
      ]
    ]),
    acknowledgements: new Map(), // messageId -> [] rows
    receipts: new Map(), // messageId -> [] rows

    schedulePeriods: [
      {
        id: periodId,
        facility_id: facilityId,
        department_id: null,
        week_start_date: weekStartDate,
        week_end_date: weekEndDate,
        status: "published",
        publish_version: 1,
        created_at: nowIso()
      }
    ],
    shifts: new Map([
      [
        periodId,
        [
          {
            id: shiftId,
            facility_id: facilityId,
            schedule_period_id: periodId,
            role_code: "lifeguard",
            shift_date: today,
            starts_at: shiftStart,
            ends_at: shiftEnd,
            created_at: nowIso()
          }
        ]
      ]
    ]),
    // Pre-seeded assignment: exists in the mock from the moment the store is
    // created, never inserted by anything the journey itself does. Status
    // "approved" (not e.g. "assigned") because schedule-board.mjs's
    // ACTIVE_ASSIGNMENT_STATUSES is {pending, approved} -- anything else
    // would render as if unassigned.
    shiftAssignments: new Map([
      [periodId, [{ id: assignmentId, facility_id: facilityId, shift_id: shiftId, employee_id: employeeId, status: "approved", created_at: nowIso() }]]
    ]),

    certifications: [
      {
        id: certId,
        employee_id: employeeId,
        certification_type_code: "cpr_aed",
        certification_type_name: "CPR/AED",
        status: "active",
        expires_at: inTenDays,
        evidence_path: null
      }
    ],

    trainingAssignments: [],
    departments: []
  };
}

// --- Auth / me -----------------------------------------------------------

export function signIn(store, { email, password } = {}) {
  if (!email || !password) {
    return { status: 400, json: { error: "email and password are required" } };
  }
  return {
    status: 200,
    json: {
      access_token: `mock-pilot-access-token-${randomUUID()}`,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: store.userId, email: store.email }
    }
  };
}

export function meResponse(store) {
  return {
    user: { id: store.userId, email: store.email },
    platformAdmin: false,
    facilities: [
      {
        id: store.facility.id,
        name: store.facility.name,
        organizationId: store.facility.organizationId,
        organizationName: store.facility.organizationName,
        permissions: [...MANAGER_PERMISSIONS],
        employeeId: store.employeeId
      }
    ]
  };
}

// --- Report templates / submissions ---------------------------------------

export function listReportTemplates(store, { all = false } = {}) {
  return [...store.reportTemplates.values()].filter((template) => all || template.status === "published");
}

export function createReportSubmission(store, { templateId, reportDate, payload = {} } = {}) {
  const template = store.reportTemplates.get(templateId);
  if (!template) return { status: 404, json: { error: "report template not found" } };
  const versionId = store.activeVersionByTemplate.get(templateId);
  const id = `report-${randomUUID()}`;
  const row = {
    id,
    facility_id: store.facilityId,
    department_id: template.department_id,
    template_id: templateId,
    template_version_id: versionId,
    report_date: reportDate,
    shift_ref: null,
    status: "draft",
    payload_json: payload || {},
    source: "web",
    submitted_by: null,
    submitted_at: null,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  store.reportSubmissions.set(id, row);
  return { status: 201, json: row };
}

export function listReports(store, { status, templateId, from, to } = {}) {
  let rows = [...store.reportSubmissions.values()];
  if (status) rows = rows.filter((r) => r.status === status);
  if (templateId) rows = rows.filter((r) => r.template_id === templateId);
  if (from) rows = rows.filter((r) => r.report_date >= from);
  if (to) rows = rows.filter((r) => r.report_date <= to);
  return [...rows].sort((a, b) => (a.report_date < b.report_date ? 1 : -1));
}

export function getReportDetail(store, id) {
  const submission = store.reportSubmissions.get(id);
  if (!submission) return { status: 404, json: { error: "report not found" } };
  const version = store.reportVersions.get(submission.template_version_id);
  const template = store.reportTemplates.get(submission.template_id);
  return {
    status: 200,
    json: {
      submission,
      schema_json: version ? version.schema_json : null,
      template_name: template ? template.name : null,
      attachments: store.reportAttachments.get(id) || []
    }
  };
}

export function patchReportSubmission(store, id, patch = {}) {
  const submission = store.reportSubmissions.get(id);
  if (!submission) return { status: 404, json: { error: "report not found" } };
  if (submission.status !== "draft") {
    return { status: 409, json: { error: "only draft reports can be edited" } };
  }
  if (patch.payload !== undefined) submission.payload_json = patch.payload;
  if (patch.shiftRef !== undefined) submission.shift_ref = patch.shiftRef;
  submission.updated_at = nowIso();
  return { status: 200, json: submission };
}

export function submitReportSubmission(store, id) {
  const submission = store.reportSubmissions.get(id);
  if (!submission) return { status: 404, json: { error: "report not found" } };
  if (submission.status !== "draft") {
    return { status: 409, json: { error: "only draft reports can be submitted" } };
  }
  submission.status = "submitted";
  submission.submitted_by = store.userId;
  submission.submitted_at = nowIso();
  submission.updated_at = nowIso();
  return { status: 200, json: submission };
}

export function addReportAttachment(store, submissionId, { fieldKey, fileName, contentType } = {}) {
  const submission = store.reportSubmissions.get(submissionId);
  if (!submission) return { status: 404, json: { error: "report not found" } };
  const id = `report-attachment-${randomUUID()}`;
  const row = {
    id,
    facility_id: store.facilityId,
    submission_id: submissionId,
    field_key: fieldKey || null,
    storage_path: `facilities/${store.facilityId}/reports/${submissionId}/${id}-${fileName || "upload"}`,
    mime_type: contentType || "application/octet-stream",
    checksum: "mock-checksum",
    metadata: {},
    created_at: nowIso()
  };
  const existing = store.reportAttachments.get(submissionId) || [];
  store.reportAttachments.set(submissionId, [...existing, row]);
  return { status: 201, json: row };
}

export function listReportAttachments(store, submissionId) {
  return store.reportAttachments.get(submissionId) || [];
}

// Per-published-template counts of {expected, submitted, missing, overdue}
// over [from, to] (inclusive) -- deliberately simplified against the real
// computeCompliance (src/lib/reports-compliance.mjs): every published
// template "expects" exactly one submission across the whole range, and
// `submitted` counts real report_submissions rows in a submitted-or-later
// status within range. That's enough to prove the live-state property this
// mock exists for (a submit made during the journey moves this number,
// nothing here is a static snapshot) without reimplementing the server's
// own per-day-per-department scheduling rules.
const SUBMITTED_STATUSES = new Set(["submitted", "locked", "revised"]);

export function reportsCompliance(store, { from, to } = {}) {
  const templates = [...store.reportTemplates.values()].filter((t) => t.status === "published");
  const submissions = [...store.reportSubmissions.values()].filter(
    (r) => r.report_date >= from && r.report_date <= to && SUBMITTED_STATUSES.has(r.status)
  );
  return {
    from,
    to,
    templates: templates.map((template) => {
      const submitted = submissions.filter((r) => r.template_id === template.id).length;
      const expected = 1;
      return {
        id: template.id,
        code: template.code,
        name: template.name,
        expected,
        submitted,
        missing: Math.max(expected - submitted, 0),
        overdue: 0
      };
    })
  };
}

// --- Incidents -------------------------------------------------------------

let incidentSeq = 0;

export function listIncidents(store, { status } = {}) {
  let rows = [...store.incidents.values()];
  if (status) rows = rows.filter((r) => r.status === status);
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function createIncident(store, payload = {}) {
  incidentSeq += 1;
  const id = `incident-${randomUUID()}`;
  const row = {
    id,
    incident_no: `INC-${String(incidentSeq).padStart(4, "0")}`,
    facility_id: store.facilityId,
    department_id: payload.departmentId ?? null,
    report_type: payload.reportType,
    severity: payload.severity,
    occurred_at: payload.occurredAt,
    location_text: payload.locationText,
    summary: payload.summary,
    immediate_actions: payload.immediateActions ?? null,
    requires_osha_review: !!payload.requiresOshaReview,
    legal_hold: !!payload.legalHold,
    status: "draft",
    created_by: store.userId,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  store.incidents.set(id, row);
  store.incidentPeople.set(id, []);
  return { status: 201, json: row };
}

export function getIncident(store, id) {
  const row = store.incidents.get(id);
  if (!row) return { status: 404, json: { error: "incident not found" } };
  return { status: 200, json: row };
}

export function submitIncident(store, id) {
  const row = store.incidents.get(id);
  if (!row) return { status: 404, json: { error: "incident not found" } };
  row.status = "submitted";
  row.updated_at = nowIso();
  return { status: 200, json: row };
}

export function listPeople(store, incidentId) {
  return store.incidentPeople.get(incidentId) || [];
}

export function addPerson(store, incidentId, payload = {}) {
  if (!store.incidents.has(incidentId)) return { status: 404, json: { error: "incident not found" } };
  const id = `person-${randomUUID()}`;
  const row = {
    id,
    incident_id: incidentId,
    facility_id: store.facilityId,
    person_role: payload.personRole,
    full_name: payload.fullName,
    contact_json: payload.contact || {},
    injury_json: payload.injury || {},
    created_at: nowIso()
  };
  const existing = store.incidentPeople.get(incidentId) || [];
  store.incidentPeople.set(incidentId, [...existing, row]);
  store.incidentStatements.set(id, []);
  return { status: 201, json: row };
}

export function listStatements(store, personId) {
  return store.incidentStatements.get(personId) || [];
}

export function addStatement(store, personId, payload = {}) {
  const existing = store.incidentStatements.get(personId);
  if (existing === undefined) return { status: 404, json: { error: "person not found" } };
  const id = `statement-${randomUUID()}`;
  const row = {
    id,
    person_id: personId,
    version_no: existing.length + 1,
    statement_text: payload.statementText,
    submitted_at: nowIso(),
    signed_at: null
  };
  store.incidentStatements.set(personId, [...existing, row]);
  return { status: 201, json: row };
}

// --- Work orders / employees -----------------------------------------------

export function listWorkOrders(store, { status, assignee } = {}) {
  let rows = [...store.workOrders.values()];
  if (status) rows = rows.filter((r) => r.status === status);
  if (assignee) rows = rows.filter((r) => r.assigned_to_employee_id === assignee);
  return rows;
}

export function listEmployees(store) {
  return store.employees;
}

// --- Communications ----------------------------------------------------------

export function listChannels(store) {
  return store.channels;
}

export function listMessages(store, { status } = {}) {
  let rows = [...store.messages.values()];
  if (status) rows = rows.filter((m) => (status === "published" ? !!m.published_at : m.status === status));
  return rows;
}

export function listAcknowledgements(store, messageId, { employeeId } = {}) {
  const rows = store.acknowledgements.get(messageId) || [];
  if (!employeeId) return rows;
  const resolvedEmployeeId = employeeId === "me" ? store.employeeId : employeeId;
  return rows.filter((r) => r.employee_id === resolvedEmployeeId);
}

// The state transition step 5 exists to prove: acknowledging a message adds
// an acknowledgement row for the CALLING employee, so a later
// GET .../acknowledgements?employeeId=me (from either this session or a
// fresh reload) reflects it -- never just an in-memory flag on the response
// object the client happened to keep from the POST.
export function acknowledgeMessage(store, messageId, employeeId) {
  if (!store.messages.has(messageId)) return { status: 404, json: { error: "message not found" } };
  const existing = store.acknowledgements.get(messageId) || [];
  if (existing.some((r) => r.employee_id === employeeId)) {
    return { status: 200, json: existing.find((r) => r.employee_id === employeeId) };
  }
  const row = {
    id: `ack-${randomUUID()}`,
    facility_id: store.facilityId,
    message_id: messageId,
    employee_id: employeeId,
    ack_state: "acknowledged",
    acknowledged_at: nowIso(),
    ack_method: "web",
    signature_path: null,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  store.acknowledgements.set(messageId, [...existing, row]);
  return { status: 201, json: row };
}

export function recordReceipt(store, messageId, employeeId) {
  const existing = store.receipts.get(messageId) || [];
  const row = {
    id: `receipt-${randomUUID()}`,
    facility_id: store.facilityId,
    message_id: messageId,
    employee_id: employeeId,
    delivered_at: nowIso(),
    read_at: nowIso(),
    created_at: nowIso()
  };
  store.receipts.set(messageId, [...existing, row]);
  return { status: 201, json: row };
}

export function messageCompliance(store, messageId) {
  const message = store.messages.get(messageId);
  if (!message) return { status: 404, json: { error: "message not found" } };
  const total = store.employees.length;
  const acknowledged = (store.acknowledgements.get(messageId) || []).length;
  return {
    status: 200,
    json: {
      delivered: (store.receipts.get(messageId) || []).length,
      read: (store.receipts.get(messageId) || []).length,
      acknowledged,
      pending: Math.max(total - acknowledged, 0),
      overdue: 0,
      total
    }
  };
}

// --- Scheduling --------------------------------------------------------------

export function listSchedulePeriods(store) {
  return store.schedulePeriods;
}

export function listShifts(store, periodId) {
  return store.shifts.get(periodId) || [];
}

export function listShiftAssignments(store, periodId) {
  return store.shiftAssignments.get(periodId) || [];
}

// --- Certifications / training -----------------------------------------------

export function listCertifications(store) {
  return store.certifications;
}

export function listTrainingAssignments(store) {
  return store.trainingAssignments;
}

// --- Search ------------------------------------------------------------------

function matches(q, ...fields) {
  const needle = q.toLowerCase();
  return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
}

// Mirrors src/lib/http/search-routes.mjs's leg shape ({q, results: {incidents,
// workOrders, employees, messages}}), searching the SAME live store every
// other endpoint reads/writes -- an incident created earlier in the journey
// is searchable the moment it exists, no separate indexing step.
export function search(store, q) {
  const incidents = [...store.incidents.values()].filter((i) => matches(q, i.incident_no, i.summary, i.location_text));
  const workOrders = [...store.workOrders.values()].filter((w) => matches(q, w.title, w.description));
  const employees = store.employees.filter((e) => matches(q, e.first_name, e.last_name, e.employee_no));
  const messages = [...store.messages.values()].filter((m) => matches(q, m.subject, m.body_text));
  const results = {};
  if (incidents.length) results.incidents = incidents;
  if (workOrders.length) results.workOrders = workOrders;
  if (employees.length) results.employees = employees;
  if (messages.length) results.messages = messages;
  return { q, results };
}

// --- HTTP-shaped dispatcher --------------------------------------------------
// Everything above is plain store-in/store-out logic; this is the one part
// that knows how those functions map onto method + pathname + query-string,
// used by scripts/pilot-journey.mjs's page.route() handler. `pathname` is
// always relative to /api/v1 (the caller strips that prefix, mirroring how
// every src/public/js/app.js call already omits it via API_BASE).
export function routeMock(store, { method, pathname, searchParams, body }) {
  const seg = pathname.split("/").filter(Boolean);

  if (method === "POST" && pathname === "/auth/sign-in") return signIn(store, body || {});
  if (method === "POST" && pathname === "/auth/sign-out") return { status: 200, json: {} };
  if (method === "GET" && pathname === "/me") return { status: 200, json: meResponse(store) };

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "report-templates" && seg.length === 3) {
    return { status: 200, json: listReportTemplates(store, { all: searchParams.get("status") === "all" }) };
  }
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "reports" && seg.length === 3) {
    return {
      status: 200,
      json: listReports(store, {
        status: searchParams.get("status") || undefined,
        templateId: searchParams.get("template_id") || undefined,
        from: searchParams.get("from") || undefined,
        to: searchParams.get("to") || undefined
      })
    };
  }
  if (method === "POST" && seg[0] === "facilities" && seg[2] === "reports" && seg.length === 3) {
    return createReportSubmission(store, body || {});
  }
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "reports" && seg[3] === "compliance") {
    return { status: 200, json: reportsCompliance(store, { from: searchParams.get("from"), to: searchParams.get("to") }) };
  }
  if (method === "GET" && seg[0] === "reports" && seg[2] === "detail") return getReportDetail(store, seg[1]);
  if (method === "PATCH" && seg[0] === "reports" && seg.length === 2) return patchReportSubmission(store, seg[1], body || {});
  if (method === "POST" && seg[0] === "reports" && seg[2] === "submit") return submitReportSubmission(store, seg[1]);
  if (method === "POST" && seg[0] === "reports" && seg[2] === "attachments") {
    return addReportAttachment(store, seg[1], body || {});
  }
  if (method === "GET" && seg[0] === "reports" && seg[2] === "attachments") {
    return { status: 200, json: listReportAttachments(store, seg[1]) };
  }

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "departments") return { status: 200, json: store.departments };

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "incidents" && seg.length === 3) {
    return { status: 200, json: listIncidents(store, { status: searchParams.get("status") || undefined }) };
  }
  if (method === "POST" && seg[0] === "facilities" && seg[2] === "incidents" && seg.length === 3) {
    return createIncident(store, body || {});
  }
  if (method === "GET" && seg[0] === "incidents" && seg.length === 2) return getIncident(store, seg[1]);
  if (method === "POST" && seg[0] === "incidents" && seg[2] === "submit") return submitIncident(store, seg[1]);
  if (method === "GET" && seg[0] === "incidents" && seg[2] === "followups") return { status: 200, json: [] };
  if (method === "GET" && seg[0] === "incidents" && seg[2] === "amendments") return { status: 200, json: [] };
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "incident-escalations") return { status: 200, json: [] };
  if (method === "GET" && seg[2] === "incidents" && seg[4] === "people" && seg.length === 5) {
    return { status: 200, json: listPeople(store, seg[3]) };
  }
  if (method === "POST" && seg[2] === "incidents" && seg[4] === "people" && seg.length === 5) {
    return addPerson(store, seg[3], body || {});
  }
  if (method === "GET" && seg[4] === "people" && seg[6] === "statements" && seg.length === 7) {
    return { status: 200, json: listStatements(store, seg[5]) };
  }
  if (method === "POST" && seg[4] === "people" && seg[6] === "statements" && seg.length === 7) {
    return addStatement(store, seg[5], body || {});
  }
  if (method === "GET" && seg[0] === "incidents" && seg[2] === "attachments") return { status: 200, json: [] };

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "work-orders" && seg.length === 3) {
    return {
      status: 200,
      json: listWorkOrders(store, { status: searchParams.get("status") || undefined, assignee: searchParams.get("assignee") || undefined })
    };
  }
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "employees") return { status: 200, json: listEmployees(store) };

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "channels") return { status: 200, json: listChannels(store) };
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "messages" && seg.length === 3) {
    return { status: 200, json: listMessages(store, { status: searchParams.get("status") || undefined }) };
  }
  if (method === "GET" && seg[2] === "messages" && seg[4] === "acknowledgements") {
    return { status: 200, json: listAcknowledgements(store, seg[3], { employeeId: searchParams.get("employeeId") }) };
  }
  if (method === "GET" && seg[2] === "messages" && seg[4] === "compliance") return messageCompliance(store, seg[3]);
  if (method === "POST" && seg[0] === "messages" && seg[2] === "receipt") return recordReceipt(store, seg[1], store.employeeId);
  if (method === "POST" && seg[0] === "messages" && seg[2] === "acknowledge") return acknowledgeMessage(store, seg[1], store.employeeId);

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "schedule-periods") return { status: 200, json: listSchedulePeriods(store) };
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "shifts") {
    return { status: 200, json: listShifts(store, searchParams.get("period_id")) };
  }
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "shift-assignments") {
    return { status: 200, json: listShiftAssignments(store, searchParams.get("period_id")) };
  }

  if (method === "GET" && seg[0] === "facilities" && seg[2] === "employee-certifications") {
    return { status: 200, json: listCertifications(store) };
  }
  if (method === "GET" && seg[0] === "facilities" && seg[2] === "training-assignments") {
    return { status: 200, json: listTrainingAssignments(store) };
  }

  if (method === "GET" && pathname === "/search") return { status: 200, json: search(store, searchParams.get("q") || "") };

  // Fallback: every other GET this journey doesn't specifically drive (any
  // list route not exercised above) answers an empty list, exactly like
  // a11y-check.mjs's own catch-all; every other write answers an empty
  // object. Neither shape is ever asserted on by the journey -- it's just
  // enough for app.js's own `|| []`/render-empty-state fallbacks to render
  // cleanly instead of throwing.
  if (method === "GET") return { status: 200, json: [] };
  return { status: 200, json: {} };
}
