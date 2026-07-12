import { api } from "../api.js";
import { el, toast } from "../ui.js";

// Mirrors src/lib/admin/export.mjs's EXPORTABLE_TABLES allow-list. Kept here
// rather than fetched so the picker is available without an extra round trip
// (the server still re-checks the allow-list and the caller's permission on
// every request -- this list is UI convenience only, not a trust boundary).
const EXPORTABLE_TABLES = [
  "report_submissions",
  "incident_reports",
  "work_orders",
  "schedule_shifts",
  "messages",
  "training_assignments",
  "employee_certifications",
  "audit_events"
];

// Builds the "Data Export" utility panel: table picker + format picker +
// download button. Rendered as a sub-panel of the Audit & Compliance page
// (pages/audit.js) rather than its own nav entry, per the Phase 6 plan's
// choice of keeping the left nav at the 10 design groups.
export function buildDataExportPanel({ facilityId, statusRegion }) {
  const panel = el("div", { class: "subpanel data-export" }, [el("h3", {}, ["Data export"])]);

  const tableSelect = el(
    "select",
    { id: "export-table", "aria-label": "Table to export" },
    EXPORTABLE_TABLES.map((table) => el("option", { value: table }, [table]))
  );
  const formatSelect = el(
    "select",
    { id: "export-format", "aria-label": "Export format" },
    [
      el("option", { value: "csv" }, ["CSV"]),
      el("option", { value: "json" }, ["JSON"]),
      el("option", { value: "pdf" }, ["PDF"])
    ]
  );
  const downloadButton = el("button", { type: "button", class: "primary-button" }, ["Download export"]);
  downloadButton.addEventListener("click", () =>
    downloadExport({ facilityId, table: tableSelect.value, format: formatSelect.value, statusRegion, downloadButton })
  );

  panel.append(
    el("p", { class: "detail-subhead" }, [
      "Export a facility's operational data without touching SQL. Choose a table and a format, then download."
    ]),
    el("div", { class: "inline-form" }, [
      el("label", {}, [el("span", {}, ["Table"]), tableSelect]),
      el("label", {}, [el("span", {}, ["Format"]), formatSelect]),
      downloadButton
    ])
  );
  return panel;
}

// Turns an export envelope's body into the Blob part to download. Binary
// formats (PDF) arrive base64-encoded (encoding: "base64") because the
// envelope travels inside a JSON response; decode with atob into raw bytes so
// the Blob holds the real binary. csv/json bodies are plain text and pass
// through unchanged. Shared with pages/audit.js's downloadExport.
export function decodeExportBody(pkg) {
  if (pkg.encoding !== "base64") return pkg.body;
  const binary = atob(pkg.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Same Blob-download pattern as pages/audit.js's downloadExport: the export
// endpoint requires the same Bearer auth header as every other admin API
// call, so a bare <a href> can't hit it directly -- api.get already attaches
// that header, and the server hands back {contentType, filename, body}
// rather than a raw file response.
async function downloadExport({ facilityId, table, format, statusRegion, downloadButton }) {
  downloadButton.disabled = true;
  try {
    const pkg = await api.get(
      `/facilities/${encodeURIComponent(facilityId)}/export/${encodeURIComponent(table)}?format=${format}`
    );
    const blob = new Blob([decodeExportBody(pkg)], { type: pkg.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: pkg.filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    if (statusRegion) statusRegion.textContent = `Downloaded ${pkg.filename}.`;
    toast(`Downloaded ${pkg.filename}.`, { tone: "success" });
  } catch (error) {
    if (statusRegion) statusRegion.textContent = `Could not export ${table}: ${error.message}`;
    toast(`Could not export ${table}: ${error.message}`, { tone: "error" });
  } finally {
    downloadButton.disabled = false;
  }
}
