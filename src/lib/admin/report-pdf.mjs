// DR-15 (plans/DAILY_REPORTS_PLAN.md): single-submission PDF export. Renders
// the PINNED template version's schema + a submission's payload as a
// sectioned Q/A document, with a header (facility/department/type/date) and
// a footer (submitter/submitted_at/revision marker), by reusing the
// zero-dependency renderer in pdf.mjs (renderPdfDocument) -- no new PDF
// assembly code, only the shaping of one "record" for it to render.
//
// renderPdfDocument's model is columns (label strings) + rows (records); it
// prints every column as a "label: value" line for every row, in explicit
// column order. This module deliberately flattens the whole document -- the
// header block, one pseudo-heading + field lines per schema section, and the
// footer block -- into a SINGLE row with an explicit, fully-ordered column
// list, rather than one row per section: renderPdfDocument unions column
// sets across rows and reprints every column for every row (blank when
// absent), which would spray each section's fields as blank lines across
// every other section's block. A single row sidesteps that entirely. Field
// labels are not guaranteed unique by report-schema.mjs (only field.key is),
// so dedupeLabel() disambiguates a repeat with a " (2)", " (3)", ... suffix
// before it becomes a column/row key, guaranteeing no answer is silently
// overwritten by a same-labeled field elsewhere in the schema.
import { Buffer } from "node:buffer";
import { renderPdfDocument } from "./pdf.mjs";

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

// Renders one field's answer as display text. Missing/empty answers render
// as "(no answer)" rather than a blank line, so an unanswered required field
// is visually obvious on the printed page.
function formatAnswer(field, value) {
  if (value === undefined || value === null || value === "") return "(no answer)";
  if (field?.type === "checkbox") return value === true ? "Yes" : value === false ? "No" : "(no answer)";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "(no answer)";
  return String(value);
}

// Builds the flattened {columns, row} pair described in the module header.
function buildRecord({ header, schema, payload, footer }) {
  const seen = new Set();
  const columns = [];
  const row = {};
  const addField = (label, value) => {
    const column = dedupeLabel(label, seen);
    columns.push(column);
    row[column] = value;
  };

  for (const [label, value] of header) addField(label, value ?? "—");

  for (const section of schema?.sections ?? []) {
    // Plain ASCII on purpose (not an em dash / typographic rule): pdf.mjs's
    // renderer maps any character above Latin-1 to "?", so a fancier
    // separator would come out mangled. "==" is unambiguous and always
    // Latin-1-safe.
    addField(`== ${section.title ?? "Section"} ==`, "");
    for (const field of section.fields ?? []) {
      addField(field.label ?? field.key, formatAnswer(field, payload?.[field.key]));
    }
  }

  for (const [label, value] of footer) addField(label, value ?? "—");

  return { columns, row };
}

// Renders the PDF document (a Buffer of raw PDF bytes) for one report
// submission. All inputs are plain, already-resolved values -- this module
// does no I/O; the route layer (reports-routes.mjs) resolves facility/
// department/template names, the pinned version's schema, and the
// submitter's name before calling this.
export function renderReportSubmissionPdf({
  facilityName,
  departmentName,
  templateName,
  templateCode,
  reportDate,
  shiftRef,
  status,
  schema,
  payload,
  submitterName,
  submittedAt,
  revisionMarker
} = {}) {
  const header = [
    ["Facility", facilityName],
    ["Department", departmentName],
    ["Report Type", templateName],
    ["Template Code", templateCode],
    ["Report Date", reportDate],
    ["Shift", shiftRef],
    ["Status", status]
  ];
  const footer = [
    ["Submitted By", submitterName],
    ["Submitted At", submittedAt],
    ["Revision", revisionMarker ?? "Original"]
  ];
  const { columns, row } = buildRecord({ header, schema, payload, footer });
  // ASCII hyphen, not an em dash: kept Latin-1-safe for the same reason as
  // the section-heading separator above.
  const title = [templateName ?? "Daily Report", reportDate].filter(Boolean).join(" - ");
  return renderPdfDocument({ title, columns, rows: [row] });
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Shapes the standard export envelope ({contentType, filename, body,
// encoding: 'base64'}) the other export routes already use (export.mjs's
// buildExportPackage, audit-export.mjs), so the route layer can spread it
// straight into a response alongside a contentDisposition header.
export function buildReportPdfPackage(args = {}) {
  const document = renderReportSubmissionPdf(args);
  const filename = `report-${args.submissionId ?? "export"}-${timestampSlug()}.pdf`;
  return {
    contentType: "application/pdf",
    filename,
    body: Buffer.from(document).toString("base64"),
    encoding: "base64"
  };
}
