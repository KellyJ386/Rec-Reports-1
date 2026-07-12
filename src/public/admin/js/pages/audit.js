import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast, formatDateTime } from "../ui.js";
import { getContext } from "../state.js";

// Tables fn_audit_admin_change (0010/0012) writes 'config.changed' rows for.
// Mirrors the trigger attachment list; kept here rather than fetched so the
// filter is available even before the timeline's first load returns.
const ENTITY_TABLES = [
  "organizations",
  "facilities",
  "organization_module_settings",
  "facility_module_overrides",
  "facility_settings",
  "department_settings",
  "branding_profiles",
  "admin_change_requests",
  "organization_admins",
  "roles",
  "role_permissions",
  "memberships"
];

const DEFAULT_LIMIT = 50;

export async function renderAudit(container) {
  container.append(el("h1", {}, ["Audit & Compliance"]));

  const context = getContext();
  if (!context.facilityId) {
    container.append(emptyState("Select a facility in the top bar to view its audit timeline."));
    return;
  }
  const facilityId = context.facilityId;

  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  const toolsSection = el("section", { class: "panel", "aria-labelledby": "audit-tools-heading" }, [
    el("h2", { id: "audit-tools-heading" }, ["Chain integrity & export"])
  ]);
  container.append(toolsSection);
  toolsSection.append(buildToolsPanel({ facilityId, statusRegion, getFilters: () => filters }));

  const timelineSection = el("section", { class: "panel", "aria-labelledby": "audit-timeline-heading" }, [
    el("h2", { id: "audit-timeline-heading" }, ["Timeline"])
  ]);
  container.append(timelineSection);

  let filters = { entityTable: "", eventType: "", limit: DEFAULT_LIMIT };
  const timelineBody = el("div", {}, []);

  timelineSection.append(
    buildFilterForm({
      onApply: (next) => {
        filters = next;
        loadAndRenderTimeline();
      }
    })
  );
  timelineSection.append(timelineBody);

  async function loadAndRenderTimeline() {
    clearChildren(timelineBody);
    timelineBody.append(emptyState("Loading audit events…"));
    let rows = [];
    try {
      rows = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/audit${buildQuery(filters)}`)) ?? [];
    } catch (error) {
      clearChildren(timelineBody);
      timelineBody.append(errorBanner(`Could not load the audit timeline: ${error.message}`));
      return;
    }
    clearChildren(timelineBody);
    timelineBody.append(buildTimelineTable(rows));
  }

  await loadAndRenderTimeline();
}

function buildQuery({ entityTable, eventType, limit }) {
  const params = new URLSearchParams();
  if (entityTable) params.set("entityTable", entityTable);
  if (eventType) params.set("eventType", eventType);
  if (limit) params.set("limit", String(limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

function buildFilterForm({ onApply }) {
  const entitySelect = el("select", { id: "audit-filter-entity", "aria-label": "Entity table" }, [
    el("option", { value: "" }, ["All entity tables"]),
    ...ENTITY_TABLES.map((table) => el("option", { value: table }, [table]))
  ]);
  const eventInput = el("input", {
    type: "text",
    id: "audit-filter-event",
    placeholder: "e.g. config.changed",
    autocomplete: "off"
  });
  const limitInput = el("input", {
    type: "number",
    id: "audit-filter-limit",
    min: "1",
    max: "1000",
    value: String(DEFAULT_LIMIT)
  });

  const form = el(
    "form",
    {
      class: "inline-form",
      "aria-label": "Filter audit timeline",
      onsubmit: (event) => {
        event.preventDefault();
        const limitValue = Number(limitInput.value);
        onApply({
          entityTable: entitySelect.value,
          eventType: eventInput.value.trim(),
          limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : DEFAULT_LIMIT
        });
      }
    },
    [
      el("label", {}, [el("span", {}, ["Entity table"]), entitySelect]),
      el("label", {}, [el("span", {}, ["Event type"]), eventInput]),
      el("label", {}, [el("span", {}, ["Limit"]), limitInput]),
      el("button", { type: "submit", class: "primary-button" }, ["Apply filters"])
    ]
  );
  return form;
}

function buildTimelineTable(rows) {
  if (rows.length === 0) {
    return emptyState("No audit events match these filters.");
  }

  const table = el("table", { class: "data-table" }, [
    el("caption", { class: "sr-only" }, ["Audit timeline with expandable before/after diffs"]),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Time"]),
        el("th", { scope: "col" }, ["Event"]),
        el("th", { scope: "col" }, ["Entity"]),
        el("th", { scope: "col" }, ["Entity ID"]),
        el("th", { scope: "col" }, ["Actor"]),
        el("th", { scope: "col" }, ["Actions"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  table.append(tbody);

  for (const row of rows) {
    const diffRow = el("tr", { class: "audit-diff-row", hidden: true }, []);
    const diffCell = el("td", { colspan: "6" }, []);
    diffRow.append(diffCell);
    diffCell.append(buildDiffView(row.event_payload));

    const toggleButton = el("button", { type: "button", class: "ghost-button" }, ["View diff"]);
    toggleButton.addEventListener("click", () => {
      const nowHidden = !diffRow.hidden;
      diffRow.hidden = nowHidden;
      toggleButton.textContent = nowHidden ? "View diff" : "Hide diff";
      toggleButton.setAttribute("aria-expanded", nowHidden ? "false" : "true");
    });

    tbody.append(
      el("tr", {}, [
        el("td", {}, [formatDateTime(row.created_at)]),
        el("td", {}, [row.event_type ?? ""]),
        el("td", {}, [row.entity_table ?? ""]),
        el("td", { class: "cell-hint" }, [row.entity_id ?? ""]),
        el("td", {}, [row.actor_user_id ?? el("span", { class: "cell-muted" }, ["system"])]),
        el("td", { class: "row-actions" }, [toggleButton])
      ])
    );
    tbody.append(diffRow);
  }

  return tableScroll(table);
}

// Shallow key-level diff of an audit_events payload's before/after objects.
// Keys are classified added/removed/changed/unchanged; non-object before/after
// (e.g. a fresh INSERT's null before) is treated as an empty object so every
// key on the other side reads as added/removed rather than throwing.
function diffPayload(payload) {
  const before = payload && typeof payload.before === "object" && payload.before !== null ? payload.before : {};
  const after = payload && typeof payload.after === "object" && payload.after !== null ? payload.after : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const rows = [];
  for (const key of keys) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    let status = "unchanged";
    if (hasBefore && !hasAfter) status = "removed";
    else if (!hasBefore && hasAfter) status = "added";
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) status = "changed";
    rows.push({ key, status, before: before[key], after: after[key] });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function formatDiffValue(value) {
  if (value === undefined) return "—";
  if (value === null) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function buildDiffView(payload) {
  const rows = diffPayload(payload);
  if (rows.length === 0) {
    return emptyState("No before/after payload on this event.");
  }
  const table = el("table", { class: "data-table diff-table" }, [
    el("caption", { class: "sr-only" }, ["Before/after field diff"]),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Field"]),
        el("th", { scope: "col" }, ["Before"]),
        el("th", { scope: "col" }, ["After"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  table.append(tbody);
  for (const row of rows) {
    tbody.append(
      el("tr", { class: `diff-row diff-${row.status}` }, [
        el("td", {}, [row.key, " ", el("span", { class: `badge diff-badge-${row.status}` }, [row.status])]),
        el("td", {}, [formatDiffValue(row.before)]),
        el("td", {}, [formatDiffValue(row.after)])
      ])
    );
  }
  return tableScroll(table);
}

function buildToolsPanel({ facilityId, statusRegion, getFilters }) {
  const panel = el("div", { class: "subpanel audit-tools" }, []);

  const verifyButton = el("button", { type: "button", class: "primary-button" }, ["Verify chain integrity"]);
  const verifyResult = el("div", { class: "audit-verify-result" }, []);
  verifyButton.addEventListener("click", async () => {
    verifyButton.disabled = true;
    clearChildren(verifyResult);
    try {
      const result = await api.get(`/facilities/${encodeURIComponent(facilityId)}/audit/verify`);
      const badge = result.valid
        ? el("span", { class: "badge badge-allowed" }, ["PASS"])
        : el("span", { class: "badge badge-denied" }, ["FAIL"]);
      verifyResult.append(badge);
      verifyResult.append(
        el("span", { class: "cell-hint" }, [
          result.valid
            ? ` ${result.checked} audit row(s) verified.`
            : ` broken at row ${result.brokenAt} of ${result.checked} checked.`
        ])
      );
      statusRegion.textContent = result.valid
        ? "Chain integrity verified: no tampering detected."
        : `Chain integrity check failed at row ${result.brokenAt}.`;
      toast(result.valid ? "Chain integrity: PASS" : "Chain integrity: FAIL", {
        tone: result.valid ? "success" : "error"
      });
    } catch (error) {
      verifyResult.append(errorBanner(`Could not verify chain integrity: ${error.message}`));
    } finally {
      verifyButton.disabled = false;
    }
  });

  const csvButton = el("button", { type: "button", class: "ghost-button" }, ["Export CSV"]);
  const jsonButton = el("button", { type: "button", class: "ghost-button" }, ["Export JSON"]);
  csvButton.addEventListener("click", () =>
    downloadExport({ facilityId, format: "csv", filters: getFilters(), statusRegion, button: csvButton })
  );
  jsonButton.addEventListener("click", () =>
    downloadExport({ facilityId, format: "json", filters: getFilters(), statusRegion, button: jsonButton })
  );

  panel.append(
    el("p", { class: "detail-subhead" }, [
      "Recompute the hash chain against the stored rows, or export the current timeline filters."
    ]),
    el("div", { class: "row-actions" }, [verifyButton, csvButton, jsonButton]),
    verifyResult
  );
  return panel;
}

// The export endpoint requires the same Bearer auth header as every other
// admin API call, so a bare <a href> can't hit it directly. api.js's api.get
// already attaches that header; the server (constrained to the same JSON
// sendJson primitive every other route uses) hands back
// {contentType, filename, body} rather than a raw file response, so the
// download itself is completed here: wrap `body` in a same-typed Blob and
// click a throwaway object-URL anchor.
async function downloadExport({ facilityId, format, filters, statusRegion, button }) {
  button.disabled = true;
  try {
    const query = buildQuery(filters);
    const separator = query ? "&" : "?";
    const pkg = await api.get(
      `/facilities/${encodeURIComponent(facilityId)}/audit/export${query}${separator}format=${format}`
    );
    const blob = new Blob([pkg.body], { type: pkg.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: pkg.filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    statusRegion.textContent = `Downloaded ${pkg.filename}.`;
    toast(`Downloaded ${pkg.filename}.`, { tone: "success" });
  } catch (error) {
    statusRegion.textContent = `Could not export the audit timeline: ${error.message}`;
    toast(`Could not export the audit timeline: ${error.message}`, { tone: "error" });
  } finally {
    button.disabled = false;
  }
}
