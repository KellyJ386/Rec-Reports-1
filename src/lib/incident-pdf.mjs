// IN-08: incident summary/legal-packet PDF. Pure -- no I/O, no Date.now()/
// new Date() calls of its own. Every timestamp printed (occurred_at,
// reported_at, amendment timestamps, the integrity block's "generated at")
// comes verbatim from the caller's already-loaded rows or from the caller-
// supplied `generatedAt` string, so the same fixture always produces the
// same bytes -- the whole point of a document whose integrity is meant to be
// checkable later (see the Integrity block below).
//
// Follows report-pdf.mjs's pattern exactly: flatten the whole document into
// ONE record (an explicit, fully-ordered column list + a single row) and
// hand it to admin/pdf.mjs's renderPdfDocument, rather than one row per
// section/person/follow-up/escalation/amendment -- renderPdfDocument unions
// column sets across rows and reprints every column for every row (blank
// when absent), which would scatter each section's fields as blank lines
// through every other section's block. A single row sidesteps that (see
// report-pdf.mjs's module header for the same reasoning).
//
// Draft-export decision (IN-08 item 3): a draft MAY be exported -- there is
// no reason to block an early, informal PDF (e.g. a supervisor wants a
// printable copy while still gathering facts) -- but the document is
// watermarked "DRAFT - NOT SUBMITTED" in both the bold title line and an
// explicit body field, so a draft's PDF can never be mistaken for a filed,
// submitted incident report. See the route comment on
// GET /incidents/:id/export.pdf in incidents-routes.mjs for the enforcement
// side of this choice.
import { Buffer } from "node:buffer";
import { renderPdfDocument } from "./admin/pdf.mjs";
import { computeRowHash } from "./audit.mjs";

function dedupeLabel(label, seen) {
  let candidate = label;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${label} (${n})`;
    n += 1;
  }
  seen.add(candidate);
  return candidate;
}

// Renders one field's value as display text. Missing/empty values print as
// an ASCII "--" (not a typographic em dash: pdf.mjs's renderer maps any
// character above Latin-1 to "?", so a fancier placeholder would come out
// mangled on the printed page -- the same reasoning as report-pdf.mjs's
// "==" section-heading rule).
function displayOrDash(value) {
  if (value === undefined || value === null || value === "") return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Builds the flattened {columns, row} pair the module header describes.
function buildRecord({ header, sections, footer }) {
  const seen = new Set();
  const columns = [];
  const row = {};
  const addField = (label, value) => {
    const column = dedupeLabel(label, seen);
    columns.push(column);
    row[column] = value;
  };

  for (const [label, value] of header) addField(label, value);
  for (const section of sections) {
    // ASCII "==" heading rule, verbatim from report-pdf.mjs: pdf.mjs maps
    // any character above Latin-1 to "?", so a typographic rule would come
    // out mangled; "==" is unambiguous and always Latin-1-safe.
    addField(`== ${section.title} ==`, "");
    for (const [label, value] of section.fields) addField(label, value);
  }
  for (const [label, value] of footer) addField(label, value);

  return { columns, row };
}

function personFields(person, index) {
  const n = index + 1;
  return [
    [`Person ${n} Role`, person.person_role],
    [`Person ${n} Name`, person.full_name],
    [`Person ${n} Contact`, person.contact_json && Object.keys(person.contact_json).length > 0 ? person.contact_json : null],
    [`Person ${n} Injury`, person.injury_json && Object.keys(person.injury_json).length > 0 ? person.injury_json : null],
    [`Person ${n} Statement`, person.statement_text]
  ];
}

function followupFields(followup, index) {
  const n = index + 1;
  return [
    [`Follow-up ${n} Type`, followup.action_type],
    [`Follow-up ${n} Owner`, followup.owner_user_id],
    [`Follow-up ${n} Status`, followup.status],
    [`Follow-up ${n} Due At`, followup.due_at],
    [`Follow-up ${n} Description`, followup.description],
    [`Follow-up ${n} Completed At`, followup.completed_at]
  ];
}

function escalationFields(escalation, index) {
  const n = index + 1;
  return [
    [`Escalation ${n} Level`, escalation.escalation_level],
    [`Escalation ${n} Reason`, escalation.reason_code],
    [`Escalation ${n} Target Role`, escalation.target_role],
    [`Escalation ${n} Status`, escalation.status],
    [`Escalation ${n} Due At`, escalation.due_at],
    [`Escalation ${n} Acknowledged At`, escalation.acknowledged_at]
  ];
}

// Reason/actor/timestamp are the three fields IN-08 requires; changed-field
// names are included too since they are cheap context an amendment's own
// row already carries (via buildAmendment's before/after snapshots) and
// meaningfully answer "amended -- to say WHAT changed".
function amendmentFields(amendment, index) {
  const n = index + 1;
  const before = amendment.before_snapshot ?? {};
  const after = amendment.after_snapshot ?? {};
  const changedFields = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  return [
    [`Amendment ${n} Reason`, amendment.amendment_reason],
    [`Amendment ${n} Actor`, amendment.amended_by],
    [`Amendment ${n} Timestamp`, amendment.amended_at],
    [`Amendment ${n} Changed Fields`, changedFields.length > 0 ? changedFields.join(", ") : null]
  ];
}

// Canonical content fingerprint for the Integrity block. Hashes the
// case-defining content actually printed (not the rendered PDF bytes
// themselves, which would make the hash depend on pagination/font-layout
// implementation details rather than the document's substance) plus
// `generatedAt`, so the hash also pins WHEN this particular export was
// produced. Reuses audit.mjs's computeRowHash (sha-256 over a
// deterministically-key-sorted canonical form, prevHash null -- the same
// "self-contained content hash" shape buildIncidentAuditEvent/buildAmendment
// already use) rather than inventing a second hashing scheme.
export function computeIncidentDocumentHash({
  incident,
  people = [],
  followups = [],
  escalations = [],
  amendments = [],
  generatedAt
}) {
  return computeRowHash(null, {
    incident: {
      id: incident?.id ?? null,
      incident_no: incident?.incident_no ?? null,
      status: incident?.status ?? null,
      severity: incident?.severity ?? null,
      report_type: incident?.report_type ?? null,
      occurred_at: incident?.occurred_at ?? null,
      summary: incident?.summary ?? null,
      immediate_actions: incident?.immediate_actions ?? null,
      requires_osha_review: incident?.requires_osha_review ?? null,
      legal_hold: incident?.legal_hold ?? null
    },
    people: (people ?? []).map((p) => ({
      id: p.id ?? null,
      person_role: p.person_role ?? null,
      full_name: p.full_name ?? null,
      contact_json: p.contact_json ?? null,
      injury_json: p.injury_json ?? null,
      statement_text: p.statement_text ?? null
    })),
    followups: (followups ?? []).map((f) => ({
      id: f.id ?? null,
      action_type: f.action_type ?? null,
      status: f.status ?? null,
      due_at: f.due_at ?? null,
      description: f.description ?? null,
      completed_at: f.completed_at ?? null
    })),
    escalations: (escalations ?? []).map((e) => ({
      id: e.id ?? null,
      escalation_level: e.escalation_level ?? null,
      reason_code: e.reason_code ?? null,
      status: e.status ?? null,
      due_at: e.due_at ?? null,
      acknowledged_at: e.acknowledged_at ?? null
    })),
    amendments: (amendments ?? []).map((a) => ({
      id: a.id ?? null,
      amendment_reason: a.amendment_reason ?? null,
      amended_by: a.amended_by ?? null,
      amended_at: a.amended_at ?? null,
      before_snapshot: a.before_snapshot ?? null,
      after_snapshot: a.after_snapshot ?? null
    })),
    generatedAt: generatedAt ?? null
  });
}

// Renders the incident case document (a Buffer of raw PDF bytes). All
// inputs are plain, already-resolved values -- this module does no I/O; the
// route layer (incidents-routes.mjs) resolves facility/department names and
// loads people/follow-ups/escalations/amendments before calling this.
// `generatedAt` is REQUIRED and must be an ISO timestamp supplied by the
// caller (the route stamps it once, at request time) -- this function never
// reads the clock itself, which is what makes its output reproducible for a
// fixed fixture.
export function renderIncidentPdf({
  facilityName,
  departmentName,
  incident,
  people = [],
  followups = [],
  escalations = [],
  amendments = [],
  generatedAt,
  generatedBy
} = {}) {
  const isDraft = incident?.status === "draft";
  const isAmended = (amendments ?? []).length > 0;

  const statusTag = isDraft ? " [DRAFT - NOT SUBMITTED]" : "";
  const amendedTag = isAmended ? " [AMENDED]" : "";
  const title = `Incident Report ${incident?.incident_no ?? incident?.id ?? "(unnumbered)"}${statusTag}${amendedTag}`;

  const header = [
    ["Incident No", incident?.incident_no],
    ["Report Type", incident?.report_type],
    ["Severity", incident?.severity],
    ["Status", incident?.status],
    ["Occurred At", incident?.occurred_at],
    ["Reported At", incident?.reported_at],
    ["Location", incident?.location_text],
    ["Facility", facilityName ?? incident?.facility_id],
    ["Department", departmentName ?? incident?.department_id],
    ["Summary", incident?.summary],
    ["Immediate Actions", incident?.immediate_actions],
    ["OSHA Review Required", incident?.requires_osha_review],
    ["Legal Hold", incident?.legal_hold],
    ["Submitted By", incident?.submitted_by],
    ["Submitted At", incident?.submitted_at]
  ];

  // Explicit, always-present markers (in addition to the bold title tags
  // above) so a reader skimming only the body text -- not just the title --
  // still cannot miss either state.
  if (isDraft) {
    header.push(["DOCUMENT STATUS", "DRAFT - THIS INCIDENT HAS NOT BEEN SUBMITTED"]);
  }
  if (isAmended) {
    header.push([
      "AMENDMENT STATUS",
      `AMENDED - this report has been amended ${amendments.length} time(s) since submission; see Amendment History below`
    ]);
  }

  const sections = [
    {
      title: "Involved People",
      fields:
        (people ?? []).length > 0
          ? people.flatMap((person, index) => personFields(person, index))
          : [["Involved People", "None recorded"]]
    },
    {
      title: "Follow-Up Actions",
      fields:
        (followups ?? []).length > 0
          ? followups.flatMap((followup, index) => followupFields(followup, index))
          : [["Follow-Up Actions", "None recorded"]]
    },
    {
      title: "Escalation History",
      fields:
        (escalations ?? []).length > 0
          ? escalations.flatMap((escalation, index) => escalationFields(escalation, index))
          : [["Escalation History", "None recorded"]]
    },
    {
      title: "Amendment History",
      fields: isAmended
        ? amendments.flatMap((amendment, index) => amendmentFields(amendment, index))
        : [["Amendment History", "None (this report has not been amended)"]]
    }
  ];

  const documentHash = computeIncidentDocumentHash({
    incident,
    people,
    followups,
    escalations,
    amendments,
    generatedAt
  });

  // "sha256:<hex>" (rather than a separate "(SHA-256)" label suffix) keeps
  // the whole "label: value" line under pdf.mjs's WRAP_WIDTH so it prints on
  // one line instead of wrapping the hash across two.
  sections.push({
    title: "Integrity",
    fields: [
      ["Document Hash", `sha256:${documentHash}`],
      ["Generated At", generatedAt],
      ["Generated By", generatedBy]
    ]
  });

  // buildRecord's addField prints raw values through pdf.mjs's own
  // stringifyValue (objects JSON.stringified, everything else String()'d)
  // except booleans, which it would otherwise render as the bare words
  // "true"/"false" -- displayOrDash normalizes those to Yes/No and empty/
  // missing values to "--" before they ever reach renderPdfDocument. Section
  // heading rows (blank-string values) are added directly by buildRecord,
  // not through this helper, so there is no blank-value case to preserve
  // here.
  const normalize = (fields) => fields.map(([label, value]) => [label, displayOrDash(value)]);
  const { columns, row } = buildRecord({
    header: normalize(header),
    sections: sections.map((s) => ({ title: s.title, fields: normalize(s.fields) })),
    footer: []
  });

  return renderPdfDocument({ title, columns, rows: [row] });
}

function timestampSlug(generatedAt) {
  return String(generatedAt).replace(/[:.]/g, "-");
}

// Shapes the standard export envelope ({contentType, filename, body,
// encoding: 'base64'}) the other export routes already use (report-pdf.mjs's
// buildReportPdfPackage, export.mjs's buildExportPackage, audit-export.mjs).
// Also returns `documentHash` alongside the envelope -- not part of the wire
// envelope itself, but the route layer needs the same hash for the
// incident_audit_events row it writes on every export (an export of a legal
// document is itself auditable), and recomputing it separately would risk
// it drifting from what's actually printed in the Integrity block.
export function buildIncidentPdfPackage(args = {}) {
  const document = renderIncidentPdf(args);
  const documentHash = computeIncidentDocumentHash(args);
  const filename = `incident-${args.incident?.incident_no ?? args.incident?.id ?? "export"}-${timestampSlug(args.generatedAt)}.pdf`;
  return {
    contentType: "application/pdf",
    filename,
    body: Buffer.from(document).toString("base64"),
    encoding: "base64",
    documentHash
  };
}
