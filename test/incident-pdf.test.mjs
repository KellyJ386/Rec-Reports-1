import test from "node:test";
import assert from "node:assert/strict";
import {
  renderIncidentPdf,
  buildIncidentPdfPackage,
  computeIncidentDocumentHash,
  renderIncidentPacket,
  buildIncidentPacketPackage,
  computeIncidentPacketHash
} from "../src/lib/incident-pdf.mjs";
import { verifyIncidentAuditChain, computeIncidentAuditRowHash } from "../src/lib/audit.mjs";

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

// =============================================================================
// renderIncidentPacket / buildIncidentPacketPackage / computeIncidentPacketHash
// (IN-18)
// =============================================================================

const STATEMENT_V1 = {
  id: "stmt-1",
  person_id: "person-1",
  version_no: 1,
  statement_text: "I slipped on a wet tile.",
  submitted_by: "user-1",
  submitted_at: "2026-07-18T11:05:00Z",
  signed_at: "2026-07-18T11:10:00Z",
  deleted_at: null
};

const STATEMENT_V2 = {
  id: "stmt-2",
  person_id: "person-1",
  version_no: 2,
  statement_text: "I slipped on a wet tile near the diving board.",
  submitted_by: "user-1",
  submitted_at: "2026-07-19T09:00:00Z",
  signed_at: null,
  deleted_at: null
};

const EVIDENCE_WITH_CHECKSUM = {
  id: "att-1",
  attachment_type: "photo",
  storage_path: "facilities/fac-1/incidents/inc-1/wet-tile.jpg",
  captured_at: "2026-07-18T10:05:00Z",
  captured_by: "user-1",
  checksum_sha256: "a".repeat(64),
  metadata: { byte_size: 204800 }
};

const EVIDENCE_NO_CHECKSUM = {
  id: "att-2",
  attachment_type: "document",
  storage_path: "facilities/fac-1/incidents/inc-1/report.pdf",
  captured_at: "2026-07-18T10:10:00Z",
  captured_by: "user-1",
  checksum_sha256: null,
  metadata: {}
};

const SIGNATURE = {
  id: "sig-1",
  role: "supervisor",
  signed_name: "Alex Manager",
  attestation_text: "I attest this report is accurate.",
  signed_at: "2026-07-20T00:00:00Z"
};

const COMPLIANCE_CHECK = {
  id: "cc-1",
  check_type: "supervisor_signoff",
  result: "pass",
  notes: "Reviewed and confirmed",
  checked_by: "user-3",
  checked_at: "2026-07-20T00:00:00Z"
};

// A real, verifiable facility-wide incident_audit_events chain: three rows,
// two of which belong to THIS incident (inc-1) and one that belongs to a
// different incident (inc-2) in the same facility -- proving that chain
// verification must run over the whole facility, not a per-incident-filtered
// subset (see incidents-routes.mjs's GET .../packet.pdf and audit.mjs's
// verifyIncidentAuditChain doc comments).
function buildFacilityChain() {
  const rows = [];
  let prevHash = null;
  const specs = [
    { id: 1, incident_id: "inc-1", event_type: "incident.created", event_payload: {}, created_at: "2026-07-18T10:00:00Z" },
    { id: 2, incident_id: "inc-2", event_type: "incident.created", event_payload: {}, created_at: "2026-07-18T10:01:00Z" },
    {
      id: 3,
      incident_id: "inc-1",
      event_type: "incident.submitted",
      event_payload: { actor: "user-1" },
      created_at: "2026-07-18T12:00:00Z"
    }
  ];
  for (const spec of specs) {
    const row = { ...spec, facility_id: "fac-1", actor_user_id: "user-1", prev_hash: prevHash };
    row.row_hash = computeIncidentAuditRowHash(row);
    rows.push(row);
    prevHash = row.row_hash;
  }
  return rows;
}

function buildPacketArgs(overrides = {}) {
  const chainRows = buildFacilityChain();
  const auditEvents = chainRows.filter((row) => row.incident_id === "inc-1");
  const chainVerification = verifyIncidentAuditChain(chainRows);
  return {
    facilityName: "Riverside Rec Center",
    departmentName: "Aquatics",
    incident: { ...INCIDENT, id: "inc-1" },
    people: [PERSON],
    statements: [STATEMENT_V1, STATEMENT_V2],
    attachments: [EVIDENCE_WITH_CHECKSUM, EVIDENCE_NO_CHECKSUM],
    amendments: [],
    auditEvents,
    followups: [FOLLOWUP],
    escalations: [ESCALATION],
    signatures: [SIGNATURE],
    complianceChecks: [COMPLIANCE_CHECK],
    chainVerification,
    generatedAt: GENERATED_AT,
    generatedBy: "user-9",
    ...overrides
  };
}

test("renderIncidentPacket emits a well-formed PDF (header/trailer/fonts)", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.match(text, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
});

test("renderIncidentPacket includes the cover/summary section (same fields as the summary PDF)", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.match(text, /\(Incident No: INC-2026-0001\) Tj/);
  assert.match(text, /\(Facility: Riverside Rec Center\) Tj/);
  assert.match(text, /\(Legal Hold: No\) Tj/);
});

test("renderIncidentPacket includes involved people and every witness statement version with signed status", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.match(text, /== Involved People ==/);
  assert.match(text, /\(Person 1 Name: Jane Doe\) Tj/);

  assert.match(text, /== Witness Statements ==/);
  assert.match(text, /\(Statement 1 Version: 1\) Tj/);
  // PDF-string escaping backslash-escapes the literal parens in "(...)",
  // same as report-pdf.test.mjs's "(no answer)" case.
  assert.match(text, /Statement 1 Signed: Yes \\\(2026-07-18T11:10:00Z\\\)/);
  assert.match(text, /\(Statement 2 Version: 2\) Tj/);
  assert.match(text, /\(Statement 2 Signed: No\) Tj/);
});

test("renderIncidentPacket includes signatures and compliance checks when the rows exist", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.match(text, /== Signatures ==/);
  assert.match(text, /\(Signature 1 Role: supervisor\) Tj/);
  assert.match(text, /\(Signature 1 Signed Name: Alex Manager\) Tj/);

  assert.match(text, /== Compliance Checks ==/);
  assert.match(text, /\(Compliance Check 1 Check Type: supervisor_signoff\) Tj/);
  assert.match(text, /\(Compliance Check 1 Result: pass\) Tj/);
});

test("renderIncidentPacket omits signatures/compliance-checks sections entirely when the arrays are empty (defensive absence)", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs({ signatures: [], complianceChecks: [] })));
  assert.doesNotMatch(text, /== Signatures ==/);
  assert.doesNotMatch(text, /== Compliance Checks ==/);
});

test("renderIncidentPacket omits signatures/compliance-checks when the args are simply absent (sibling table not in this tree)", () => {
  const args = buildPacketArgs();
  delete args.signatures;
  delete args.complianceChecks;
  const text = asText(renderIncidentPacket(args));
  assert.doesNotMatch(text, /== Signatures ==/);
  assert.doesNotMatch(text, /== Compliance Checks ==/);
  // Every other section still renders fine.
  assert.match(text, /== Evidence Index ==/);
});

test("renderIncidentPacket's evidence index includes storage paths, byte size, and notes 'checksum unavailable' when absent", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.match(text, /== Evidence Index ==/);
  assert.match(text, /\(Evidence 1 Storage Path: facilities\/fac-1\/incidents\/inc-1\/wet-tile\.jpg\) Tj/);
  assert.match(text, /\(Evidence 1 Byte Size: 204800\) Tj/);
  assert.match(text, /Evidence 1 SHA-256: a{64}/);
  assert.match(text, /\(Evidence 2 SHA-256: checksum unavailable\) Tj/);
});

test("renderIncidentPacket's audit timeline lists only THIS incident's rows, with prev/row hashes, and embeds facility-wide chain verification", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.match(text, /== Audit Timeline ==/);
  assert.match(text, /\(Audit 1 Type: incident\.created\) Tj/);
  assert.match(text, /\(Audit 2 Type: incident\.submitted\) Tj/);
  // Only 2 of this incident's events, never the sibling incident's row --
  // "Audit 3" would only appear if inc-2's row leaked into the timeline.
  assert.doesNotMatch(text, /\(Audit 3 Type:/);
  assert.match(text, /\(Audit 1 Row Hash: [0-9a-f]{64}\) Tj/);

  assert.match(text, /== Audit Chain Verification ==/);
  assert.match(text, /\(Chain Valid: Yes\) Tj/);
});

test("renderIncidentPacket's chain verification block reports a broken chain when the facility-wide chain is tampered with", () => {
  const chainRows = buildFacilityChain();
  chainRows[1].event_payload = { tampered: true }; // mutate the middle row post-hoc, in place
  const brokenVerification = verifyIncidentAuditChain(chainRows);
  const text = asText(renderIncidentPacket(buildPacketArgs({ chainVerification: brokenVerification })));
  assert.match(text, /\(Chain Valid: No\) Tj/);
  assert.match(text, /\(Chain Broken At: 1\) Tj/);
});

// M1 (security review): "Chain Valid: true" must never print over a chain
// the route marked truncated (the facility-wide fetch hit its row cap, so
// only a prefix was actually checked) or unread (noRows).
test("renderIncidentPacket's chain verification block reports NOT valid and names the reason when truncated", () => {
  const chainRows = buildFacilityChain();
  const rawVerification = verifyIncidentAuditChain(chainRows); // valid: true in isolation
  const text = asText(
    renderIncidentPacket(buildPacketArgs({ chainVerification: { ...rawVerification, truncated: true } }))
  );
  assert.match(text, /\(Chain Valid: No\) Tj/);
  assert.match(text, /NOT FULLY VERIFIED/);
});

test("renderIncidentPacket's chain verification block reports NOT valid and names the reason when no rows were readable", () => {
  const text = asText(
    renderIncidentPacket(buildPacketArgs({ chainVerification: { valid: true, brokenAt: null, noRows: true } }))
  );
  assert.match(text, /\(Chain Valid: No\) Tj/);
  assert.match(text, /NOT VERIFIED -- no audit rows/);
});

test("renderIncidentPacket prints a Packet Integrity block, last, with a packet-level sha256", () => {
  const text = asText(renderIncidentPacket(buildPacketArgs()));
  assert.match(text, /== Packet Integrity ==/);
  assert.match(text, /\(Packet Hash: sha256:[0-9a-f]{64}\) Tj/);
  assert.match(text, /\(Generated At: 2026-08-16T00:00:00\.000Z\) Tj/);
  assert.match(text, /\(Generated By: user-9\) Tj/);
  // Last section pushed -- appears after every other section heading in the
  // emitted content stream.
  const packetIdx = text.indexOf("== Packet Integrity ==");
  const evidenceIdx = text.indexOf("== Evidence Index ==");
  const auditIdx = text.indexOf("== Audit Timeline ==");
  assert.ok(packetIdx > evidenceIdx && packetIdx > auditIdx);
});

test("computeIncidentPacketHash is deterministic and changes when any section's content changes", () => {
  const args = buildPacketArgs();
  const hashA = computeIncidentPacketHash(args);
  const hashB = computeIncidentPacketHash(args);
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[0-9a-f]{64}$/);

  const hashDifferentStatement = computeIncidentPacketHash({
    ...args,
    statements: [{ ...STATEMENT_V1, statement_text: "different text" }, STATEMENT_V2]
  });
  assert.notEqual(hashA, hashDifferentStatement);

  const hashDifferentChain = computeIncidentPacketHash({
    ...args,
    chainVerification: { valid: false, brokenAt: 0 }
  });
  assert.notEqual(hashA, hashDifferentChain);
});

test("renderIncidentPacket produces byte-identical output for a fixed fixture with the clock frozen", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-16T00:00:00.000Z") });
  const args = buildPacketArgs();
  const first = renderIncidentPacket(args);
  const second = renderIncidentPacket(args);
  assert.deepEqual(first, second);
  assert.ok(Buffer.compare(first, second) === 0);
});

test("renderIncidentPacket watermarks a draft incident and marks an amended one, same as the summary PDF", () => {
  const draftText = asText(
    renderIncidentPacket(buildPacketArgs({ incident: { ...INCIDENT, id: "inc-1", status: "draft" } }))
  );
  assert.match(draftText, /\[DRAFT - NOT SUBMITTED\]/);
  assert.match(draftText, /DOCUMENT STATUS/);

  const amendedText = asText(renderIncidentPacket(buildPacketArgs({ amendments: [AMENDMENT] })));
  assert.match(amendedText, /\[AMENDED\]/);
  assert.match(amendedText, /== Amendment History ==/);
  assert.match(amendedText, /\(Amendment 1 Reason: Investigation revealed the correct location\) Tj/);
});

test("buildIncidentPacketPackage returns the standard export envelope with a distinct 'packet' filename", () => {
  const pkg = buildIncidentPacketPackage(buildPacketArgs());
  assert.equal(pkg.contentType, "application/pdf");
  assert.equal(pkg.encoding, "base64");
  assert.match(pkg.filename, /^incident-INC-2026-0001-packet-.+\.pdf$/);
  assert.match(pkg.documentHash, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from(pkg.body, "base64").toString("latin1");
  assert.ok(bytes.startsWith("%PDF-1.4\n"));
  assert.ok(bytes.trimEnd().endsWith("%%EOF"));
});
