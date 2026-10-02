// DR-23 (plans/DAILY_REPORTS_PLAN.md): the immutable PDF SNAPSHOT of a
// submitted report -- distinct from admin/report-pdf.mjs's DR-15 on-demand
// export (GET /reports/:id/pdf, re-rendered fresh on every request from
// whatever schema/payload is live right now). This module renders the
// document the async pipeline (report-pdf-worker.mjs's processReportPdfJobs)
// files to Storage exactly once per submission and never touches again --
// the legal record of what was actually submitted.
//
// Pure -- no I/O, no Date.now()/new Date() calls of its own. Every timestamp
// printed (submitted_at, the Integrity block's "generated at") comes
// verbatim from the caller's already-loaded row or from the caller-supplied
// `generatedAt` string, so the same fixture always produces the same bytes
// -- see incident-pdf.mjs's identical header comment and
// test/incident-pdf.test.mjs's frozen-clock byte-identity test for why this
// matters and how it's proven (this module's own test file does the same).
//
// Follows incident-pdf.mjs's (and, before it, admin/report-pdf.mjs's) exact
// pattern: flatten the whole document into ONE record (an explicit,
// fully-ordered column list + a single row) and hand it to admin/pdf.mjs's
// renderPdfDocument -- no new PDF assembly code, only the shaping of one
// "record" for the existing zero-dependency renderer. Do NOT add a second
// PDF byte-writer here; renderPdfDocument is the only thing in this codebase
// that emits PDF bytes.
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

// Renders one schema field's answer as display text -- same rules as
// admin/report-pdf.mjs's formatAnswer (missing/empty prints "(no answer)" so
// an unanswered field is visually obvious, checkboxes render Yes/No,
// multiselect/array answers join with ", ").
function formatAnswer(field, value) {
  if (value === undefined || value === null || value === "") return "(no answer)";
  if (field?.type === "checkbox") return value === true ? "Yes" : value === false ? "No" : "(no answer)";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(no answer)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Plain "--" (not a typographic em dash) for a missing header/footer value --
// pdf.mjs's renderer maps any character above Latin-1 to "?", so a fancier
// placeholder would come out mangled, exactly incident-pdf.mjs's reasoning.
function displayOrDash(value) {
  if (value === undefined || value === null || value === "") return "--";
  return String(value);
}

// Builds the flattened {columns, row} pair the module header describes.
function buildRecord({ header, sections }) {
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
    // ASCII "==" heading rule, verbatim from incident-pdf.mjs/
    // admin/report-pdf.mjs: pdf.mjs maps any character above Latin-1 to "?",
    // so a typographic rule would come out mangled; "==" is always
    // Latin-1-safe.
    addField(`== ${section.title} ==`, "");
    for (const [label, value] of section.fields) addField(label, value);
  }

  return { columns, row };
}

// Display name for an attachment row: the filename tail of
// storage.mjs's buildAttachmentPath shape
// (facilities/{facilityId}/reports/{recordId}/{uuid}-{safeName}) with the
// leading "{uuid}-" stripped so the printed snapshot shows the name a human
// actually uploaded, not the collision-avoidance prefix. Falls back to the
// raw last path segment when it doesn't match that shape (defensive -- a
// row this module was never handed by the normal upload path should still
// print *something* rather than throw).
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
export function attachmentDisplayName(pathOrRow) {
  const raw =
    typeof pathOrRow === "string" ? pathOrRow : (pathOrRow?.storage_path ?? pathOrRow?.filename ?? String(pathOrRow ?? ""));
  const tail = raw.split("/").pop() ?? raw;
  return tail.replace(UUID_PREFIX, "") || tail;
}

// Canonical content fingerprint for the Integrity block, and the same value
// the drain job uses to derive the snapshot's Storage object name
// (snapshot-<hash8>.pdf). Hashes the case-defining content actually printed
// (not the rendered PDF bytes, which would make the hash depend on
// pagination/layout implementation details) plus `generatedAt` -- reuses
// audit.mjs's computeRowHash (sha-256 over a deterministically-key-sorted
// canonical form, prevHash null), the same "self-contained content hash"
// incident-pdf.mjs's computeIncidentDocumentHash already uses, rather than
// inventing a second hashing scheme.
export function computeReportSnapshotHash({
  facilityName,
  departmentName,
  templateName,
  templateCode,
  versionNumber,
  reportDate,
  shiftRef,
  status,
  schema,
  payload,
  submitterName,
  submittedAt,
  revisionOf,
  attachments = [],
  signatures = [],
  generatedAt
} = {}) {
  return computeRowHash(null, {
    facilityName: facilityName ?? null,
    departmentName: departmentName ?? null,
    templateName: templateName ?? null,
    templateCode: templateCode ?? null,
    versionNumber: versionNumber ?? null,
    reportDate: reportDate ?? null,
    shiftRef: shiftRef ?? null,
    status: status ?? null,
    schema: schema ?? null,
    payload: payload ?? null,
    submitterName: submitterName ?? null,
    submittedAt: submittedAt ?? null,
    revisionOf: revisionOf ?? null,
    attachments: (attachments ?? []).map((a) => ({
      id: a?.id ?? null,
      name: attachmentDisplayName(a)
    })),
    signatures: (signatures ?? []).map((s) => ({
      id: s?.id ?? null,
      name: s?.signer_name ?? s?.full_name ?? null,
      role: s?.role ?? s?.signer_role ?? null,
      signedAt: s?.signed_at ?? null
    })),
    generatedAt: generatedAt ?? null
  });
}

// Renders the report snapshot document (a Buffer of raw PDF bytes). All
// inputs are plain, already-resolved values -- this module does no I/O; the
// caller (report-pdf-worker.mjs's processReportPdfJobs) resolves the
// facility/department/template names, the PINNED version's schema (never
// the template's current active version -- a re-publish after this
// submission was filed must not relabel it, matching admin/report-pdf.mjs's
// GET .../pdf route), attachments, and (when the table exists in this tree
// -- see the worker for the runtime check) signatures before calling this.
//
// `generatedAt` is REQUIRED and must be an ISO timestamp the caller derives
// from the submission's own row (submitted_at -- see the worker), NEVER
// wall-clock time: that is what makes two renders of the same submitted row,
// run at different real times (e.g. an original attempt and a later retry),
// byte-identical.
//
// Fields whose schema definition carries `hidden: true` are omitted from the
// printed section entirely (not shown blank, not shown "(no answer)") --
// hidden-field omission per DR-23's acceptance criteria. report-schema.mjs
// does not define `hidden` as a validated field property today; this is a
// forward-compatible no-op until a future builder adds it to the schema
// vocabulary.
export function renderReportSnapshotPdf({
  facilityName,
  departmentName,
  templateName,
  templateCode,
  versionNumber,
  reportDate,
  shiftRef,
  status,
  schema,
  payload,
  submitterName,
  submittedAt,
  revisionOf,
  attachments = [],
  signatures = [],
  generatedAt,
  generatedBy
} = {}) {
  const statusTag = status && status !== "submitted" ? ` [${String(status).toUpperCase()}]` : "";
  const title = `${templateName ?? "Daily Report"} Snapshot - ${reportDate ?? "(no date)"}${statusTag}`;

  const header = [
    ["Facility", facilityName],
    ["Department", departmentName],
    ["Report Type", templateName],
    ["Template Code", templateCode],
    ["Template Version", versionNumber],
    ["Report Date", reportDate],
    ["Shift", shiftRef],
    ["Status", status],
    ["Submitted By", submitterName],
    ["Submitted At", submittedAt],
    ["Revision Of", revisionOf]
  ].map(([label, value]) => [label, displayOrDash(value)]);

  const sections = [];
  for (const section of schema?.sections ?? []) {
    const visibleFields = (section.fields ?? []).filter((field) => field?.hidden !== true);
    sections.push({
      title: section.title ?? "Section",
      fields:
        visibleFields.length > 0
          ? visibleFields.map((field) => [field.label ?? field.key, formatAnswer(field, payload?.[field.key])])
          : [["(fields)", "no visible fields in this section"]]
    });
  }

  sections.push({
    title: "Attachments",
    fields:
      (attachments ?? []).length > 0
        ? attachments.map((attachment, index) => [`Attachment ${index + 1}`, attachmentDisplayName(attachment)])
        : [["Attachments", "None recorded"]]
  });

  // Signatures is a forward-compatible section: no report_submission_
  // signatures (or similar) table exists anywhere in this tree as of DR-23,
  // so the worker always passes signatures: [] today and this section is
  // simply omitted (not printed as an empty stub) rather than claiming
  // "None recorded" for a feature that does not exist yet. The moment such a
  // table lands, the worker's runtime check (see report-pdf-worker.mjs)
  // starts passing real rows through and this section starts appearing.
  if ((signatures ?? []).length > 0) {
    sections.push({
      title: "Signatures",
      fields: signatures.flatMap((signature, index) => {
        const n = index + 1;
        return [
          [`Signature ${n} Name`, signature.signer_name ?? signature.full_name],
          [`Signature ${n} Role`, signature.role ?? signature.signer_role],
          [`Signature ${n} Signed At`, signature.signed_at]
        ];
      })
    });
  }

  const documentHash = computeReportSnapshotHash({
    facilityName,
    departmentName,
    templateName,
    templateCode,
    versionNumber,
    reportDate,
    shiftRef,
    status,
    schema,
    payload,
    submitterName,
    submittedAt,
    revisionOf,
    attachments,
    signatures,
    generatedAt
  });

  // "sha256:<hex>" (one line, no separate suffix) keeps the "label: value"
  // line under pdf.mjs's WRAP_WIDTH so it prints on one line -- same reason
  // as incident-pdf.mjs's Integrity block.
  sections.push({
    title: "Integrity",
    fields: [
      ["Document Hash", `sha256:${documentHash}`],
      ["Generated At", generatedAt],
      ["Generated By", generatedBy]
    ].map(([label, value]) => [label, displayOrDash(value)])
  });

  const normalizedSections = sections.map((section) => ({
    title: section.title,
    fields: section.fields.map(([label, value]) => [label, displayOrDash(value)])
  }));

  const { columns, row } = buildRecord({ header, sections: normalizedSections });
  return renderPdfDocument({ title, columns, rows: [row] });
}

// First 8 hex characters of the document hash -- the exact fragment the
// Storage object path uses (facilities/{facilityId}/reports/{submissionId}/
// snapshot-<hash8>.pdf, see report-pdf-worker.mjs). Exported so the worker
// derives the path from the SAME hash the printed Integrity block shows,
// rather than recomputing it a second, potentially-divergent way.
export function shortHash(documentHash) {
  return String(documentHash).slice(0, 8);
}

// Shapes the standard export envelope ({contentType, filename, body,
// encoding: 'base64'}) the other export routes already use (admin/
// report-pdf.mjs's buildReportPdfPackage, incident-pdf.mjs's
// buildIncidentPdfPackage). Also returns `documentHash` -- the worker needs
// it both for the Storage path and for the pdf_content_hash column, and
// recomputing it separately would risk drift from what the Integrity block
// actually prints.
export function buildReportSnapshotPdfPackage(args = {}) {
  const document = renderReportSnapshotPdf(args);
  const documentHash = computeReportSnapshotHash(args);
  const filename = `report-${args.submissionId ?? "snapshot"}-${shortHash(documentHash)}.pdf`;
  return {
    contentType: "application/pdf",
    filename,
    body: Buffer.from(document).toString("base64"),
    encoding: "base64",
    documentHash
  };
}
