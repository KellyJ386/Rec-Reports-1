import test from "node:test";
import assert from "node:assert/strict";
import {
  renderIncidentPdf,
  buildIncidentPdfPackage,
  computeIncidentDocumentHash
} from "../src/lib/incident-pdf.mjs";

function asText(buffer) {
  return Buffer.from(buffer).toString("latin1");
}

const INCIDENT = {
  id: "inc-1",
  facility_id: "fac-1",
  department_id: "dept-1",
  incident_no: "INC-2026-0001",
  report_type: "accident",
  status: "submitted",
  severity: "high",
  occurred_at: "2026-07-18T10:00:00Z",
  reported_at: "2026-07-18T11:00:00Z",
  location_text: "Pool Deck",
  summary: "Slip and fall near the diving board",
  immediate_actions: "First aid administered, area cordoned off",
  requires_osha_review: true,
  legal_hold: false,
  submitted_by: "user-1",
  submitted_at: "2026-07-18T12:00:00Z"
};

const PERSON = {
  id: "person-1",
  person_role: "injured_party",
  full_name: "Jane Doe",
  contact_json: { phone: "555-0100" },
  injury_json: { type: "bruise", severity: "minor" },
  statement_text: "I slipped on a wet tile."
};

const FOLLOWUP = {
  id: "fu-1",
  owner_user_id: "user-2",
  action_type: "corrective_action",
  status: "open",
  due_at: "2026-07-25T00:00:00Z",
  description: "Install a wet-floor sign",
  completed_at: null
};

const ESCALATION = {
  id: "esc-1",
  escalation_level: 1,
  reason_code: "user_escalation",
  target_role: "manager",
  status: "pending",
  due_at: "2026-07-19T00:00:00Z",
  acknowledged_at: null
};

const AMENDMENT = {
  id: "amend-1",
  amendment_reason: "Investigation revealed the correct location",
  amended_by: "user-3",
  amended_at: "2026-07-20T00:00:00Z",
  before_snapshot: { summary: "Slip and fall", location_text: "Pool Deck" },
  after_snapshot: { summary: "Slip and fall near the diving board", location_text: "Pool Deck" }
};

const GENERATED_AT = "2026-08-16T00:00:00.000Z";

const BASE_ARGS = {
  facilityName: "Riverside Rec Center",
  departmentName: "Aquatics",
  incident: INCIDENT,
  people: [PERSON],
  followups: [FOLLOWUP],
  escalations: [ESCALATION],
  amendments: [],
  generatedAt: GENERATED_AT,
  generatedBy: "user-9"
};

// --- PDF structure (like test/pdf.test.mjs, test/report-pdf.test.mjs) -------

test("renderIncidentPdf emits a PDF 1.4 header and %%EOF trailer", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.equal(text.trimEnd().endsWith("%%EOF"), true);
});

test("renderIncidentPdf emits catalog, page tree, and font objects", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages \/Kids/);
  assert.match(text, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
});

test("renderIncidentPdf xref offsets point at the emitted object headers", () => {
  const bytes = asText(renderIncidentPdf(BASE_ARGS));
  const startxrefMatch = bytes.match(/startxref\n(\d+)\n%%EOF\n$/);
  assert.ok(startxrefMatch, "startxref block missing");
  const xrefOffset = Number(startxrefMatch[1]);
  assert.equal(bytes.slice(xrefOffset, xrefOffset + 5), "xref\n");

  const xrefSection = bytes.slice(xrefOffset, bytes.indexOf("trailer", xrefOffset));
  const entries = [...xrefSection.matchAll(/^(\d{10}) (\d{5}) ([fn]) $/gm)];
  const sizeMatch = bytes.match(/\/Size (\d+)/);
  assert.equal(entries.length, Number(sizeMatch[1]));

  entries.forEach((entry, index) => {
    if (index === 0) {
      assert.equal(entry[3], "f");
      return;
    }
    const offset = Number(entry[1]);
    assert.ok(
      bytes.slice(offset).startsWith(`${index} 0 obj\n`),
      `xref entry ${index} does not point at "${index} 0 obj" (offset ${offset})`
    );
  });
});

test("renderIncidentPdf content-stream Length matches its byte content", () => {
  const bytes = asText(renderIncidentPdf(BASE_ARGS));
  const streams = [...bytes.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 1);
  for (const [, length, content] of streams) {
    assert.equal(Number(length), content.length);
  }
});

// --- Content: case metadata, people, follow-ups, escalations ----------------

test("renderIncidentPdf includes case metadata", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.match(text, /\(Incident No: INC-2026-0001\) Tj/);
  assert.match(text, /\(Report Type: accident\) Tj/);
  assert.match(text, /\(Severity: high\) Tj/);
  assert.match(text, /\(Status: submitted\) Tj/);
  assert.match(text, /\(Occurred At: 2026-07-18T10:00:00Z\) Tj/);
  assert.match(text, /\(Location: Pool Deck\) Tj/);
  assert.match(text, /\(Facility: Riverside Rec Center\) Tj/);
  assert.match(text, /\(Department: Aquatics\) Tj/);
  assert.match(text, /\(OSHA Review Required: Yes\) Tj/);
  assert.match(text, /\(Legal Hold: No\) Tj/);
});

test("renderIncidentPdf includes involved people", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.match(text, /== Involved People ==/);
  assert.match(text, /\(Person 1 Role: injured_party\) Tj/);
  assert.match(text, /\(Person 1 Name: Jane Doe\) Tj/);
  assert.match(text, /I slipped on a wet tile\./);
});

test("renderIncidentPdf includes follow-up actions with owner/due/status", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.match(text, /== Follow-Up Actions ==/);
  assert.match(text, /\(Follow-up 1 Type: corrective_action\) Tj/);
  assert.match(text, /\(Follow-up 1 Owner: user-2\) Tj/);
  assert.match(text, /\(Follow-up 1 Status: open\) Tj/);
  assert.match(text, /\(Follow-up 1 Due At: 2026-07-25T00:00:00Z\) Tj/);
});

test("renderIncidentPdf includes escalation history", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.match(text, /== Escalation History ==/);
  assert.match(text, /\(Escalation 1 Level: 1\) Tj/);
  assert.match(text, /\(Escalation 1 Reason: user_escalation\) Tj/);
  assert.match(text, /\(Escalation 1 Status: pending\) Tj/);
});

test("renderIncidentPdf renders 'None recorded' when a section is empty", () => {
  const text = asText(renderIncidentPdf({ ...BASE_ARGS, people: [], followups: [], escalations: [] }));
  assert.match(text, /\(Involved People: None recorded\) Tj/);
  assert.match(text, /\(Follow-Up Actions: None recorded\) Tj/);
  assert.match(text, /\(Escalation History: None recorded\) Tj/);
});

// --- Integrity block ----------------------------------------------------------

test("renderIncidentPdf includes an integrity block with a document hash and generated-at", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.match(text, /== Integrity ==/);
  assert.match(text, /\(Document Hash: sha256:[0-9a-f]{64}\) Tj/);
  assert.match(text, /\(Generated At: 2026-08-16T00:00:00\.000Z\) Tj/);
  assert.match(text, /\(Generated By: user-9\) Tj/);
});

test("computeIncidentDocumentHash is a deterministic function of its inputs", () => {
  const hashA = computeIncidentDocumentHash(BASE_ARGS);
  const hashB = computeIncidentDocumentHash(BASE_ARGS);
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[0-9a-f]{64}$/);

  const hashDifferentGeneratedAt = computeIncidentDocumentHash({ ...BASE_ARGS, generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.notEqual(hashA, hashDifferentGeneratedAt);

  const hashDifferentSummary = computeIncidentDocumentHash({
    ...BASE_ARGS,
    incident: { ...INCIDENT, summary: "A different summary" }
  });
  assert.notEqual(hashA, hashDifferentSummary);
});

// --- Determinism: no Date.now()/new Date() of its own ------------------------
// renderIncidentPdf takes every timestamp from its inputs, but it is built on
// top of admin/pdf.mjs's renderPdfDocument, which stamps its own "Generated
// at <now>" header line from the real clock. Freezing the global Date for the
// duration of the render (via node:test's mock timers) makes that line
// deterministic too, so the FULL byte output -- not just the fields this
// module controls -- is reproducible for a fixed fixture.
test("renderIncidentPdf produces byte-identical output for a fixed fixture with the clock frozen", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-16T00:00:00.000Z") });
  const first = renderIncidentPdf(BASE_ARGS);
  const second = renderIncidentPdf(BASE_ARGS);
  assert.deepEqual(first, second);
  assert.ok(Buffer.compare(first, second) === 0);
});

test("buildIncidentPdfPackage produces a byte-identical body for a fixed fixture with the clock frozen", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-16T00:00:00.000Z") });
  const first = buildIncidentPdfPackage(BASE_ARGS);
  const second = buildIncidentPdfPackage(BASE_ARGS);
  assert.equal(first.body, second.body);
  assert.equal(first.documentHash, second.documentHash);
  assert.equal(first.filename, second.filename);
});

// --- Amended incident: visible marker + history ------------------------------

test("renderIncidentPdf marks an amended incident in the title and body, and lists amendment history", () => {
  const text = asText(renderIncidentPdf({ ...BASE_ARGS, amendments: [AMENDMENT] }));
  assert.match(text, /\(Incident Report INC-2026-0001 \[AMENDED\]\) Tj/);
  // PDF-string escaping backslash-escapes the literal parens in "(s)", same
  // as report-pdf.test.mjs's "(no answer)" case.
  assert.match(text, /AMENDED - this report has been amended 1 time\\\(s\\\) since submission/);
  assert.match(text, /== Amendment History ==/);
  assert.match(text, /\(Amendment 1 Reason: Investigation revealed the correct location\) Tj/);
  assert.match(text, /\(Amendment 1 Actor: user-3\) Tj/);
  assert.match(text, /\(Amendment 1 Timestamp: 2026-07-20T00:00:00Z\) Tj/);
  assert.match(text, /\(Amendment 1 Changed Fields: summary\) Tj/);
});

test("renderIncidentPdf does not mark an un-amended incident as amended", () => {
  const text = asText(renderIncidentPdf({ ...BASE_ARGS, amendments: [] }));
  assert.doesNotMatch(text, /\[AMENDED\]/);
  assert.doesNotMatch(text, /AMENDMENT STATUS/);
  assert.match(text, /Amendment History: None \\\(this report has not been amended\\\)/);
});

test("renderIncidentPdf lists multiple amendments in order", () => {
  const secondAmendment = {
    ...AMENDMENT,
    id: "amend-2",
    amendment_reason: "Reclassified severity after review",
    amended_by: "user-4",
    amended_at: "2026-07-21T00:00:00Z",
    before_snapshot: AMENDMENT.after_snapshot,
    after_snapshot: { ...AMENDMENT.after_snapshot, severity: "high" }
  };
  const text = asText(renderIncidentPdf({ ...BASE_ARGS, amendments: [AMENDMENT, secondAmendment] }));
  assert.match(text, /AMENDED - this report has been amended 2 time\\\(s\\\) since submission/);
  assert.match(text, /\(Amendment 1 Reason: Investigation revealed the correct location\) Tj/);
  assert.match(text, /\(Amendment 2 Reason: Reclassified severity after review\) Tj/);
});

// --- Draft watermark -----------------------------------------------------------

test("renderIncidentPdf watermarks a draft incident in the title and body", () => {
  const draftIncident = { ...INCIDENT, status: "draft", submitted_by: null, submitted_at: null };
  const text = asText(renderIncidentPdf({ ...BASE_ARGS, incident: draftIncident }));
  assert.match(text, /\(Incident Report INC-2026-0001 \[DRAFT - NOT SUBMITTED\]\) Tj/);
  assert.match(text, /DRAFT - THIS INCIDENT HAS NOT BEEN SUBMITTED/);
});

test("renderIncidentPdf does not watermark a submitted incident as a draft", () => {
  const text = asText(renderIncidentPdf(BASE_ARGS));
  assert.doesNotMatch(text, /\[DRAFT - NOT SUBMITTED\]/);
  assert.doesNotMatch(text, /DOCUMENT STATUS/);
});

test("renderIncidentPdf can mark a draft incident as BOTH draft and amended", () => {
  const draftIncident = { ...INCIDENT, status: "draft" };
  const text = asText(renderIncidentPdf({ ...BASE_ARGS, incident: draftIncident, amendments: [AMENDMENT] }));
  assert.match(text, /\[DRAFT - NOT SUBMITTED\]/);
  assert.match(text, /\[AMENDED\]/);
});

// --- Export envelope ---------------------------------------------------------

test("buildIncidentPdfPackage returns the standard export envelope plus a documentHash", () => {
  const pkg = buildIncidentPdfPackage(BASE_ARGS);
  assert.equal(pkg.contentType, "application/pdf");
  assert.equal(pkg.encoding, "base64");
  assert.match(pkg.filename, /^incident-INC-2026-0001-.+\.pdf$/);
  assert.match(pkg.documentHash, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from(pkg.body, "base64").toString("latin1");
  assert.ok(bytes.startsWith("%PDF-1.4\n"));
  assert.ok(bytes.trimEnd().endsWith("%%EOF"));
});
