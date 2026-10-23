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

// Shared cover/summary field block (IN-18: "cover + summary" is the packet's
// first section, and it is exactly this same case-metadata block the
// standalone summary PDF already opens with -- extracted so
// renderIncidentPacket reuses it verbatim instead of a second copy, per this
// module's "reuse its primitives; no second PDF writer" mandate). Pure;
// callers append their own draft/amended status markers afterward.
function incidentCoverFields({ incident, facilityName, departmentName }) {
  return [
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

  const header = incidentCoverFields({ incident, facilityName, departmentName });

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

// ===========================================================================
// IN-18: the legal packet -- a superset of the summary PDF above, extending
// it (design doc §5.1 "Legal Packet PDF bundle") with witness statement
// history, signatures/compliance checks (when those tables' rows are
// supplied -- both are owned by a sibling migration in this wave and may not
// exist in every tree; the route layer reads them defensively and this
// renderer treats an absent/empty array identically to "no rows yet"),
// evidence index, and the FULL audit timeline with chain hashes, closing
// with a packet-level integrity block. Reuses every primitive above
// (buildRecord, displayOrDash, dedupeLabel, incidentCoverFields,
// personFields, followupFields, escalationFields, amendmentFields,
// computeRowHash via audit.mjs) rather than a second PDF writer, per this
// module's header.
// ===========================================================================

function humanizeKey(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Flattens one row of an arbitrary-shaped table into `label: value` pairs,
// `preferredOrder` first (only for keys the row actually carries) then every
// other own key in whatever order Object.keys returns it. Used for
// signatures/complianceChecks (0056, a sibling migration -- IN-18 must not
// assume its exact column set) so this renderer degrades gracefully to
// "print whatever the row has" instead of hard-coding a schema this tree may
// not carry yet.
function genericRowFields(row, index, sectionLabel, preferredOrder = []) {
  const n = index + 1;
  const seen = new Set();
  const orderedKeys = [];
  for (const key of preferredOrder) {
    if (key in row && !seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(row)) {
    if (!seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }
  return orderedKeys.map((key) => [`${sectionLabel} ${n} ${humanizeKey(key)}`, row[key]]);
}

// One incident_witness_statements row -- every version, with its signed/
// removed status explicit (IN-18: "every version, signed status"). Looks the
// person's name up from `peopleById` (built once by the caller) so a reader
// does not have to cross-reference a bare person_id.
function statementFields(statement, index, peopleById) {
  const n = index + 1;
  const person = peopleById.get(statement.person_id);
  return [
    [`Statement ${n} Person`, person?.full_name ?? statement.person_id],
    [`Statement ${n} Version`, statement.version_no],
    [`Statement ${n} Submitted By`, statement.submitted_by],
    [`Statement ${n} Submitted At`, statement.submitted_at],
    [`Statement ${n} Signed`, statement.signed_at ? `Yes (${statement.signed_at})` : "No"],
    [`Statement ${n} Removed`, statement.deleted_at ? `Yes (${statement.deleted_at})` : "No"],
    [`Statement ${n} Text`, statement.statement_text]
  ];
}

// One incident_attachments row for the evidence index. checksum_sha256 is a
// nullable column (0004) -- IN-18 requires an explicit "checksum unavailable"
// note rather than a bare dash when it is absent, since a missing checksum on
// a legal-evidence index is a fact worth stating outright, not silently
// blanking. The label itself is "SHA-256" (not "Checksum: sha256:<hex>") and
// the value is the bare hex, no prefix -- a 64-char hex value plus a longer
// label plus a "sha256:" prefix pushes the printed "label: value" line past
// pdf.mjs's WRAP_WIDTH (88 chars), which would silently wrap this specific
// field (and only this one, since every other hash in this document is
// either shorter or on a narrower-labeled line) onto a second, indented
// line -- correct either way, but avoided here for one consistent look
// across the section. Byte size is read defensively from `metadata` (no
// column exists to store it -- 0056 owns incident_attachments' schema, out
// of this task's scope to extend) under any of a few plausible keys a
// future upload path might use; "--" (via displayOrDash) when none are
// present.
function evidenceFields(attachment, index) {
  const n = index + 1;
  const checksum = attachment.checksum_sha256 ?? "checksum unavailable";
  const metadata = attachment.metadata ?? {};
  const byteSize = metadata.byte_size ?? metadata.size_bytes ?? metadata.size ?? metadata.bytes ?? null;
  return [
    [`Evidence ${n} Type`, attachment.attachment_type],
    [`Evidence ${n} Storage Path`, attachment.storage_path],
    [`Evidence ${n} Byte Size`, byteSize],
    [`Evidence ${n} SHA-256`, checksum],
    [`Evidence ${n} Captured At`, attachment.captured_at],
    [`Evidence ${n} Captured By`, attachment.captured_by]
  ];
}

// One incident_audit_events row for the full timeline, WITH its chain hashes
// (IN-18: "full audit timeline with chain hashes") -- prev_hash/row_hash as
// fetched back from PostgREST (0013_audit_chain.sql), not recomputed here;
// `chainVerification` (a separate, facility-wide verifyIncidentAuditChain result the
// caller computes and passes in) is what actually vouches for them, printed
// in its own block below.
function auditTimelineFields(event, index) {
  const n = index + 1;
  return [
    [`Audit ${n} Type`, event.event_type],
    [`Audit ${n} Actor`, event.actor_user_id],
    [`Audit ${n} At`, event.created_at],
    [`Audit ${n} Payload`, event.event_payload],
    [`Audit ${n} Prev Hash`, event.prev_hash],
    [`Audit ${n} Row Hash`, event.row_hash]
  ];
}

// Canonical content fingerprint for the packet's closing Packet Integrity
// block -- the sha-256 "over the section contents" (IN-18) of every input
// this renderer actually prints, generatedAt included so two packets
// generated from identical case data at different times still hash
// differently (matching computeIncidentDocumentHash's own reasoning above).
// Deliberately does NOT hash the rendered PDF bytes themselves (pagination/
// font-layout is an implementation detail, not part of the document's legal
// substance) -- same rationale as computeIncidentDocumentHash. signatures/
// complianceChecks are spread as-is (their schema is a sibling migration's,
// unknown here); canonicalize()'s deep key-sort (audit.mjs) makes that safe
// regardless of what order their columns arrive in.
export function computeIncidentPacketHash({
  incident,
  people = [],
  statements = [],
  attachments = [],
  amendments = [],
  auditEvents = [],
  followups = [],
  escalations = [],
  signatures = [],
  complianceChecks = [],
  chainVerification,
  generatedAt
} = {}) {
  return computeRowHash(null, {
    incident: {
      id: incident?.id ?? null,
      incident_no: incident?.incident_no ?? null,
      status: incident?.status ?? null,
      severity: incident?.severity ?? null,
      legal_hold: incident?.legal_hold ?? null,
      requires_osha_review: incident?.requires_osha_review ?? null,
      summary: incident?.summary ?? null,
      immediate_actions: incident?.immediate_actions ?? null
    },
    people: (people ?? []).map((p) => ({
      id: p.id ?? null,
      person_role: p.person_role ?? null,
      full_name: p.full_name ?? null,
      contact_json: p.contact_json ?? null,
      injury_json: p.injury_json ?? null,
      statement_text: p.statement_text ?? null
    })),
    statements: (statements ?? []).map((s) => ({
      id: s.id ?? null,
      person_id: s.person_id ?? null,
      version_no: s.version_no ?? null,
      statement_text: s.statement_text ?? null,
      submitted_by: s.submitted_by ?? null,
      submitted_at: s.submitted_at ?? null,
      signed_at: s.signed_at ?? null,
      deleted_at: s.deleted_at ?? null
    })),
    attachments: (attachments ?? []).map((a) => ({
      id: a.id ?? null,
      attachment_type: a.attachment_type ?? null,
      storage_path: a.storage_path ?? null,
      checksum_sha256: a.checksum_sha256 ?? null,
      metadata: a.metadata ?? null
    })),
    amendments: (amendments ?? []).map((a) => ({
      id: a.id ?? null,
      amendment_reason: a.amendment_reason ?? null,
      amended_by: a.amended_by ?? null,
      amended_at: a.amended_at ?? null,
      before_snapshot: a.before_snapshot ?? null,
      after_snapshot: a.after_snapshot ?? null
    })),
    auditEvents: (auditEvents ?? []).map((e) => ({
      id: e.id ?? null,
      event_type: e.event_type ?? null,
      actor_user_id: e.actor_user_id ?? null,
      event_payload: e.event_payload ?? null,
      created_at: e.created_at ?? null,
      prev_hash: e.prev_hash ?? null,
      row_hash: e.row_hash ?? null
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
    signatures: (signatures ?? []).map((s) => ({ ...s })),
    complianceChecks: (complianceChecks ?? []).map((c) => ({ ...c })),
    chainVerification: chainVerification
      ? {
          valid: chainVerification.valid,
          brokenAt: chainVerification.brokenAt,
          truncated: chainVerification.truncated === true,
          noRows: chainVerification.noRows === true
        }
      : null,
    generatedAt: generatedAt ?? null
  });
}

// Renders the full legal packet (a Buffer of raw PDF bytes). Pure -- no I/O,
// no Date.now()/new Date() of its own, `generatedAt` REQUIRED (identical
// contract to renderIncidentPdf above). `chainVerification` is REQUIRED too:
// it is the {valid, brokenAt} result of running verifyIncidentAuditChain (audit.mjs)
// over the incident's FACILITY's full incident_audit_events chain -- NOT
// just this incident's own rows, since 0013_audit_chain.sql links
// incident_audit_events' prev_hash/row_hash per-facility, not per-incident;
// the route layer is what actually runs that verification (it needs a
// second, unfiltered fetch to do it correctly) and passes the result in
// here purely for display. `signatures`/`complianceChecks` are optional
// (default []) and rendered ONLY when non-empty -- "when the rows exist"
// (IN-18) -- rather than a "None recorded" placeholder, since an empty array
// here means either "no rows yet" or "the table doesn't exist in this tree"
// and this renderer cannot (and need not) tell those apart.
export function renderIncidentPacket({
  facilityName,
  departmentName,
  incident,
  people = [],
  statements = [],
  attachments = [],
  amendments = [],
  auditEvents = [],
  followups = [],
  escalations = [],
  signatures = [],
  complianceChecks = [],
  chainVerification,
  generatedAt,
  generatedBy
} = {}) {
  const isDraft = incident?.status === "draft";
  const isAmended = (amendments ?? []).length > 0;

  const statusTag = isDraft ? " [DRAFT - NOT SUBMITTED]" : "";
  const amendedTag = isAmended ? " [AMENDED]" : "";
  const title = `Incident Legal Packet ${incident?.incident_no ?? incident?.id ?? "(unnumbered)"}${statusTag}${amendedTag}`;

  // Cover + summary (IN-18 §5.1's first section) -- the identical block
  // renderIncidentPdf opens with, reused via incidentCoverFields.
  const header = incidentCoverFields({ incident, facilityName, departmentName });
  if (isDraft) {
    header.push(["DOCUMENT STATUS", "DRAFT - THIS INCIDENT HAS NOT BEEN SUBMITTED"]);
  }
  if (isAmended) {
    header.push([
      "AMENDMENT STATUS",
      `AMENDED - this report has been amended ${amendments.length} time(s) since submission; see Amendment History below`
    ]);
  }

  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));

  const sections = [
    {
      title: "Involved People",
      fields:
        (people ?? []).length > 0
          ? people.flatMap((person, index) => personFields(person, index))
          : [["Involved People", "None recorded"]]
    },
    {
      title: "Witness Statements",
      fields:
        (statements ?? []).length > 0
          ? statements.flatMap((statement, index) => statementFields(statement, index, peopleById))
          : [["Witness Statements", "None recorded"]]
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

  // Signatures/compliance checks: included ONLY when rows exist (see this
  // function's doc comment above) -- both tables belong to a sibling
  // migration (0056) and may be entirely absent from this tree; the route
  // layer reads them defensively and an empty array reaches here either way.
  if ((signatures ?? []).length > 0) {
    sections.push({
      title: "Signatures",
      fields: signatures.flatMap((signature, index) =>
        genericRowFields(signature, index, "Signature", [
          "role",
          "signed_name",
          "attestation_text",
          "signed_at",
          "signature_image_path"
        ])
      )
    });
  }
  if ((complianceChecks ?? []).length > 0) {
    sections.push({
      title: "Compliance Checks",
      fields: complianceChecks.flatMap((check, index) =>
        genericRowFields(check, index, "Compliance Check", ["check_type", "result", "notes", "checked_by", "checked_at"])
      )
    });
  }

  sections.push({
    title: "Evidence Index",
    fields:
      (attachments ?? []).length > 0
        ? attachments.flatMap((attachment, index) => evidenceFields(attachment, index))
        : [["Evidence Index", "None recorded"]]
  });

  sections.push({
    title: "Audit Timeline",
    fields:
      (auditEvents ?? []).length > 0
        ? auditEvents.flatMap((event, index) => auditTimelineFields(event, index))
        : [["Audit Timeline", "None recorded"]]
  });

  // M1 (security review): "Chain Valid: true" must never be printed over a
  // chain the packet could not actually verify. verifyIncidentAuditChain
  // (audit.mjs) reports an EMPTY input as vacuously valid -- correct for
  // that function in isolation, wrong to surface verbatim here, since
  // "empty" can mean "this facility genuinely has zero audit events" (fine)
  // or "this caller's own permissions filtered the read to zero rows"
  // (a false attestation over nothing) -- the route layer cannot always
  // distinguish those either, so `verified: false` is required alongside
  // `valid` whenever the route marks the read as not-authoritative
  // (chainVerification.truncated or chainVerification.noRows, both set by
  // incidents-routes.mjs, never by this pure renderer). "Chain Valid" prints
  // that combined verified-and-valid state; "Chain Verification Note" names
  // WHY when it does not, so the printed document itself carries the
  // caveat rather than only the API envelope.
  const chainNotVerified = chainVerification?.truncated === true || chainVerification?.noRows === true;
  sections.push({
    title: "Audit Chain Verification",
    fields: [
      ["Chain Valid", !chainNotVerified && chainVerification?.valid === true],
      ["Chain Broken At", chainVerification?.brokenAt],
      [
        "Chain Verification Note",
        chainVerification?.truncated === true
          ? "NOT FULLY VERIFIED -- the facility's audit chain exceeds the 10,000-row verification window; only a prefix was checked."
          : chainVerification?.noRows === true
            ? "NOT VERIFIED -- no audit rows were readable for this facility."
            : null
      ]
    ]
  });

  const packetHash = computeIncidentPacketHash({
    incident,
    people,
    statements,
    attachments,
    amendments,
    auditEvents,
    followups,
    escalations,
    signatures,
    complianceChecks,
    chainVerification,
    generatedAt
  });

  // Packet Integrity is deliberately the LAST section pushed (IN-18: "a
  // packet-level sha256 ... printed on the last page") -- "sha256:<hex>"
  // (rather than a separate "(SHA-256)" suffix) keeps the whole line under
  // pdf.mjs's WRAP_WIDTH, matching the summary PDF's own Integrity block.
  sections.push({
    title: "Packet Integrity",
    fields: [
      ["Packet Hash", `sha256:${packetHash}`],
      ["Generated At", generatedAt],
      ["Generated By", generatedBy]
    ]
  });

  const normalize = (fields) => fields.map(([label, value]) => [label, displayOrDash(value)]);
  const { columns, row } = buildRecord({
    header: normalize(header),
    sections: sections.map((s) => ({ title: s.title, fields: normalize(s.fields) })),
    footer: []
  });

  return renderPdfDocument({ title, columns, rows: [row] });
}

// Shapes the standard export envelope, matching buildIncidentPdfPackage
// above exactly (same {contentType, filename, body, encoding, documentHash}
// shape every export route in this codebase already returns).
export function buildIncidentPacketPackage(args = {}) {
  const document = renderIncidentPacket(args);
  const documentHash = computeIncidentPacketHash(args);
  const filename = `incident-${args.incident?.incident_no ?? args.incident?.id ?? "export"}-packet-${timestampSlug(args.generatedAt)}.pdf`;
  return {
    contentType: "application/pdf",
    filename,
    body: Buffer.from(document).toString("base64"),
    encoding: "base64",
    documentHash
  };
}
