import { fieldDescriptors, collectPayload, applyServerErrors } from "./report-form.mjs";

const TOKEN_KEY = "rr_admin_token";
const REFRESH_TOKEN_KEY = "rr_refresh_token";
const API_BASE = "/api/v1";

// State
let currentUser = null;
let currentFacility = null;
let facilities = [];
let reportTemplatesById = new Map();

// Helper: Get token from localStorage
function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

// Helper: Clear tokens and redirect to signin
function clearAuthAndRedirect() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Storage may be unavailable
  }
  window.location.assign("/signin/");
}

// Helper: Fetch with bearer token and JSON handling
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { "Accept": "application/json", ...options.headers };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`Network error: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    clearAuthAndRedirect();
    return null;
  }

  if (!response.ok) {
    const message =
      (data && (data.error || (Array.isArray(data.errors) && data.errors.join(", ")))) ||
      `Request failed with status ${response.status}`;
    const error = new Error(message);
    // Attached for callers that need the raw 4xx/5xx body rather than the
    // joined-for-humans message string above -- the report entry UI's 422
    // handling (DR-13) maps each of `data.errors` back onto its own field via
    // report-form.mjs's applyServerErrors, which needs the array intact.
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

// Initialize: Check token, load user, populate facilities
async function initialize() {
  const token = getToken();
  if (!token) {
    window.location.assign("/signin/");
    return;
  }

  try {
    const meData = await apiFetch("/me");
    if (!meData) return;

    currentUser = meData.user;
    facilities = meData.facilities || [];

    // Update header with user email
    const userEmailEl = document.getElementById("user-email");
    if (userEmailEl && currentUser.email) {
      userEmailEl.textContent = currentUser.email;
    }

    // Populate facility selector
    const facilitySelect = document.getElementById("facility-select");
    if (facilitySelect) {
      facilitySelect.innerHTML = "";
      for (const facility of facilities) {
        const option = document.createElement("option");
        option.value = facility.id;
        option.textContent = facility.name;
        facilitySelect.appendChild(option);
      }

      // Set first facility as default
      if (facilities.length > 0) {
        currentFacility = facilities[0].id;
        facilitySelect.value = currentFacility;
        await loadAllModules();
      }

      // Listen for facility changes
      facilitySelect.addEventListener("change", async (e) => {
        currentFacility = e.target.value;
        await loadAllModules();
      });
    }
  } catch (error) {
    console.error("Failed to initialize:", error);
    clearAuthAndRedirect();
  }
}

// Load all module data for current facility
async function loadAllModules() {
  if (!currentFacility) return;

  // A report form or inbox detail pane left open belongs to whichever
  // facility it was opened under -- close both before switching so a
  // (re)load never leaves a stale cross-facility submission on screen.
  reportFormController.close();
  inboxDetailController.close();

  try {
    await Promise.all([
      loadReports(),
      loadReportInbox(),
      loadSchedule(),
      loadIncidents(),
      loadWorkOrders(),
      loadMessages(),
      loadTraining(),
      loadCertifications()
    ]);
  } catch (error) {
    console.error("Error loading modules:", error);
  }
}

// Small DOM builder used by every schema-driven view added in this batch
// (the report entry form and the manager review inbox's detail pane): the
// CSP is `default-src 'self'` with no inline-script/inline-style allowance,
// and schema labels + submitted answers are attacker-controlled strings, so
// every one of those views is built with createElement/textContent here
// rather than innerHTML -- textContent (via the string/number branch below)
// never parses its input as markup, so there is no HTML-injection surface
// even for a hostile field label or answer.
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// --- Attachments (OP-17/OP-18) ---------------------------------------------
// Shared by the reports, incidents, and work-orders panels below: an
// "Attachments" toggle per item that lazily lists existing attachments and
// offers a file picker to add one. Uploads send the file's raw bytes as the
// request body (never JSON -- apiFetch's body-is-object => JSON.stringify
// would corrupt a binary body) with an x-file-name header carrying the
// percent-encoded filename, matching src/lib/http/attachments-routes.mjs's
// decodeFilenameHeader. Downloads never link straight to storage: they fetch
// a short-TTL signed url from the BFF, then open that.
const ATTACHMENT_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,image/heic,application/pdf";

// Uploads a file's raw bytes to `${API_BASE}${path}`. Deliberately bypasses
// apiFetch (whose automatic JSON body handling is wrong for a binary body)
// but mirrors its auth/401/error-shape handling. `extraHeaders` lets the
// report entry form (DR-13) tag a photo/signature upload with its field via
// x-field-key (see src/lib/http/attachments-routes.mjs), without every other
// existing caller (incidents/work-orders panels) having to know it exists.
async function uploadAttachmentFile(path, file, extraHeaders = {}) {
  const token = getToken();
  const headers = {
    Accept: "application/json",
    "Content-Type": file.type || "application/octet-stream",
    "x-file-name": encodeURIComponent(file.name || "upload"),
    ...extraHeaders
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: await file.arrayBuffer()
    });
  } catch (error) {
    throw new Error(`Network error: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    clearAuthAndRedirect();
    return null;
  }

  if (!response.ok) {
    const message =
      (data && (data.error || (Array.isArray(data.errors) && data.errors.join(", ")))) ||
      `Upload failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

// Fetches a short-TTL signed url for one attachment and opens it in a new
// tab -- the BFF route 404s (rather than 403) for a caller who can't read
// the attachment's facility, so a failure here surfaces as a normal error.
async function downloadAttachment(moduleSegment, attachmentId) {
  try {
    const data = await apiFetch(`/${moduleSegment}/attachments/${attachmentId}/url`);
    if (data && data.url) {
      window.open(data.url, "_blank", "noopener");
    }
  } catch (error) {
    console.error("Failed to get attachment download url:", error);
  }
}

// Markup for one item's collapsed "Attachments" toggle + its (initially
// empty, lazily-filled) panel. canUpload gates whether the panel offers a
// file picker once expanded -- reports pass false once a submission has
// left draft (DR-09: uploads are draft-only, though existing evidence stays
// visible after submit).
function attachmentsToggleMarkup(moduleSegment, parentId, { canUpload = true } = {}) {
  const panelId = `attachments-${moduleSegment}-${parentId}`;
  return (
    '<div class="attachments-block">' +
    `<button type="button" class="attachments-toggle-btn" data-module="${escapeHtml(moduleSegment)}" data-id="${escapeHtml(parentId)}" data-panel="${escapeHtml(panelId)}" data-can-upload="${canUpload ? "true" : "false"}">Attachments</button>` +
    `<div class="attachments-panel" id="${escapeHtml(panelId)}" hidden></div>` +
    "</div>"
  );
}

// Wires every "Attachments" toggle rendered inside `container` (called once
// after each module's innerHTML is set, same pattern as the ack/complete
// button wiring below). Expanding a panel for the first time lazily loads
// its attachment list; later toggles just show/hide the already-loaded DOM.
function wireAttachmentToggles(container) {
  container.querySelectorAll(".attachments-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(btn.dataset.panel);
      if (!panel) return;
      const willShow = panel.hidden;
      panel.hidden = !willShow;
      if (willShow && panel.dataset.loaded !== "true") {
        panel.dataset.loaded = "true";
        loadAttachmentsPanel(btn.dataset.module, btn.dataset.id, panel, btn.dataset.canUpload === "true");
      }
    });
  });
}

async function loadAttachmentsPanel(moduleSegment, parentId, panel, canUpload) {
  panel.innerHTML = "<p>Loading attachments…</p>";
  try {
    const attachments = await apiFetch(`/${moduleSegment}/${parentId}/attachments`);
    renderAttachmentsPanel(panel, moduleSegment, parentId, attachments || [], canUpload);
  } catch (error) {
    panel.innerHTML = `<p class="rr-error">Error: ${escapeHtml(error.message)}</p>`;
  }
}

function renderAttachmentsPanel(panel, moduleSegment, parentId, attachments, canUpload) {
  let html = '<div class="attachments-body">';
  if (attachments.length === 0) {
    html += "<p>No attachments yet.</p>";
  } else {
    html += '<ul class="attachments-items">';
    for (const attachment of attachments) {
      const label = attachment.mime_type || attachment.attachment_type || "file";
      const when = attachment.created_at ? new Date(attachment.created_at).toLocaleString() : "";
      html += '<li class="attachment-item">';
      html += `<span>${escapeHtml(label)}${when ? ` · ${escapeHtml(when)}` : ""}</span>`;
      html += `<button type="button" class="attachment-download-btn" data-module="${escapeHtml(moduleSegment)}" data-attachment-id="${escapeHtml(attachment.id)}">Download</button>`;
      html += "</li>";
    }
    html += "</ul>";
  }

  if (canUpload) {
    html += '<label class="attachment-upload">';
    html += "<span>Add attachment</span>";
    html += `<input type="file" class="attachment-file-input" accept="${ATTACHMENT_ACCEPT}">`;
    html += "</label>";
    html += '<p class="attachment-status" hidden></p>';
  } else {
    html += "<p class=\"item-subtitle\">Only draft reports accept new attachments.</p>";
  }

  html += "</div>";
  panel.innerHTML = html;

  panel.querySelectorAll(".attachment-download-btn").forEach((btn) => {
    btn.addEventListener("click", () => downloadAttachment(btn.dataset.module, btn.dataset.attachmentId));
  });

  const fileInput = panel.querySelector(".attachment-file-input");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const statusEl = panel.querySelector(".attachment-status");
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.classList.remove("rr-error");
        statusEl.textContent = "Uploading…";
      }
      try {
        await uploadAttachmentFile(`/${moduleSegment}/${parentId}/attachments`, file);
        fileInput.value = "";
        panel.dataset.loaded = "false";
        await loadAttachmentsPanel(moduleSegment, parentId, panel, canUpload);
      } catch (error) {
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.classList.add("rr-error");
          statusEl.textContent = `Error: ${error.message}`;
        }
      }
    });
  }
}

// Reports module ------------------------------------------------------------
// DR-13 lets a facility actually fill a template in from the browser (until
// now the panel below only ever listed templates/submissions read-only); the
// schema-driven form itself lives in createReportFormController further
// down, shared with DR-14's manager review inbox.
async function loadReports() {
  const container = document.getElementById("reports-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const [templates, reports] = await Promise.all([
      apiFetch(`/facilities/${currentFacility}/report-templates`),
      apiFetch(`/facilities/${currentFacility}/reports`)
    ]);

    renderReportsList(container, templates || [], reports || []);
  } catch (error) {
    setError(container, error.message);
  }
}

// Rebuilds the same DOM structure attachmentsToggleMarkup's string used to
// produce (`.attachments-block` > toggle button + `.attachments-panel`) with
// createElement instead, so wireAttachmentToggles (unchanged, still string/
// innerHTML-based -- it was already escapeHtml-safe before this batch) keeps
// working unmodified against these nodes.
function buildAttachmentsToggle(moduleSegment, parentId, canUpload) {
  const panelId = `attachments-${moduleSegment}-${parentId}`;
  return el("div", { class: "attachments-block" }, [
    el(
      "button",
      {
        type: "button",
        class: "attachments-toggle-btn",
        "data-module": moduleSegment,
        "data-id": parentId,
        "data-panel": panelId,
        "data-can-upload": canUpload ? "true" : "false"
      },
      "Attachments"
    ),
    el("div", { class: "attachments-panel", id: panelId, hidden: true })
  ]);
}

function renderReportsList(container, templatesData, reportsData) {
  container.textContent = "";

  if (templatesData.length === 0 && reportsData.length === 0) {
    container.append(el("p", {}, "No reports or templates available."));
    return;
  }

  if (templatesData.length > 0) {
    container.append(el("div", { class: "module-section" }, el("strong", {}, "Available templates:")));
    for (const template of templatesData) {
      const item = el("div", { class: "module-item" });
      item.append(el("div", { class: "item-title" }, template.name));
      if (template.description) {
        item.append(el("div", { class: "item-subtitle" }, template.description));
      }
      const startBtn = el("button", { type: "button", class: "primary" }, "Fill out report");
      startBtn.addEventListener("click", () => startNewReport(template));
      item.append(startBtn);
      container.append(item);
    }
  }

  if (reportsData.length > 0) {
    container.append(el("div", { class: "module-section" }, el("strong", {}, "Recent submissions:")));
    for (const report of reportsData) {
      const item = el("div", { class: "module-item" });
      item.append(el("div", {}, `${report.status} - ${report.report_date}`));
      if (report.submitted_at) {
        item.append(el("div", { class: "item-subtitle" }, `Submitted ${new Date(report.submitted_at).toLocaleDateString()}`));
      }
      const actionBtn = el(
        "button",
        { type: "button", class: "primary" },
        report.status === "draft" ? "Continue editing" : "View"
      );
      actionBtn.addEventListener("click", () => reportFormController.open(report.id));
      item.append(actionBtn);
      item.append(buildAttachmentsToggle("reports", report.id, report.status === "draft"));
      container.append(item);
    }
    wireAttachmentToggles(container);
  }
}

// Creates a fresh draft from a published template (today's date, empty
// payload) and immediately opens it in the fill form. The server pins the
// draft to the template's *current* active version (reports-routes.mjs), so
// reloading /reports/:id/detail right after creation is guaranteed to return
// that same version's schema -- no separate "fetch the schema" round trip
// needed here.
async function startNewReport(template) {
  if (!currentFacility) return;
  const area = document.getElementById("report-form-area");
  if (area) {
    area.hidden = false;
    area.textContent = "";
    area.append(el("p", {}, "Creating draft…"));
  }
  try {
    const reportDate = new Date().toISOString().slice(0, 10);
    const created = await apiFetch(`/facilities/${currentFacility}/reports`, {
      method: "POST",
      body: { templateId: template.id, reportDate, payload: {} }
    });
    await reportFormController.open(created.id);
    await loadReports();
  } catch (error) {
    if (area) {
      area.textContent = "";
      area.append(el("p", { class: "rr-error" }, `Error: ${error.message}`));
    }
  }
}

const AUTOSAVE_DELAY_MS = 2000;

// Shared engine behind both the fill-in-a-draft form (DR-13, `editable:
// true`, mounted in the Daily reports panel) and the manager review inbox's
// read-only detail pane (DR-14, `editable: false`, mounted in the inbox
// panel with an `extra` renderer bolting on attachments/validation
// results/PDF export). Two independent instances -- each with its own
// closed-over `state` -- so opening a submission in one never disturbs
// whatever the other has in progress (e.g. a manager Browse-ing the inbox
// while the same session also has an in-progress draft open above).
//
// Autosave race-avoidance: field edits call scheduleAutosave, which just
// debounces (clearTimeout + a fresh setTimeout) -- normal typing never fires
// a request per keystroke. When the timer does fire, runAutosave only starts
// a new PATCH if `state.saveInFlight` is false; if a save is already in
// flight (e.g. autosave firing right as the user hits "Save draft", or two
// autosave ticks landing close together after a slow response), it just sets
// `state.pendingAutosave = true` and returns -- no second overlapping PATCH
// is ever issued. saveDraft's `finally` block checks that flag once the
// in-flight request settles and reschedules if it was set, so the latest
// edits always get persisted eventually without two requests racing to
// overwrite each other's response.
function createReportFormController({ areaId, editable, extra }) {
  const state = {
    submissionId: null,
    templateName: "",
    descriptors: [],
    values: {},
    status: null,
    readOnly: true,
    currentSectionIndex: 0,
    saveInFlight: false,
    dirty: false,
    pendingAutosave: false,
    needsReason: false,
    fieldErrors: {},
    formErrors: [],
    fieldNodes: new Map(),
    autosaveTimer: null,
    detail: null
  };

  function area() {
    return document.getElementById(areaId);
  }

  function setSaveStatus(text, { error = false } = {}) {
    const statusEl = document.getElementById(`${areaId}-status`);
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("rr-error", !!error);
  }

  function clearFieldError(key) {
    if (state.fieldErrors[key]) delete state.fieldErrors[key];
    const node = state.fieldNodes.get(key);
    if (node) node.errorEl.textContent = "";
  }

  // Updates in-memory state only -- never re-renders the form on every
  // keystroke, which would rebuild the input nodes and steal focus/cursor
  // position out from under whoever is typing. Only navigation (section
  // change) and save/submit responses trigger a full render() / targeted
  // renderFieldErrors().
  function setFieldValue(key, value) {
    state.values[key] = value;
    clearFieldError(key);
    if (editable && !state.readOnly) scheduleAutosave();
  }

  function scheduleAutosave() {
    state.dirty = true;
    if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      state.autosaveTimer = null;
      runAutosave();
    }, AUTOSAVE_DELAY_MS);
  }

  async function runAutosave() {
    if (!state.dirty || state.readOnly) return;
    if (state.saveInFlight) {
      state.pendingAutosave = true;
      return;
    }
    await saveDraft({ silent: true });
  }

  // Recovers the raw 422 error array (or a single {error} string, wrapped)
  // from an apiFetch rejection -- apiFetch's `.message` alone is a
  // human-joined string that applyServerErrors can't map back to fields.
  function parseApiErrorDetails(error) {
    const details = error && error.details;
    if (details && Array.isArray(details.errors)) return details.errors;
    if (details && typeof details.error === "string") return [details.error];
    return [error.message];
  }

  // Updates only the per-field error nodes and the form-level banner --
  // deliberately not a full render(), for the same no-DOM-churn-while-typing
  // reason as setFieldValue above.
  function renderFieldErrors() {
    for (const [key, node] of state.fieldNodes) {
      const messages = state.fieldErrors[key] || [];
      node.errorEl.textContent = messages.join(" ");
    }
    const banner = document.getElementById(`${areaId}-banner`);
    if (banner) {
      banner.textContent = "";
      for (const message of state.formErrors) banner.append(el("p", {}, message));
      banner.hidden = state.formErrors.length === 0;
    }
  }

  async function saveDraft({ silent = false } = {}) {
    if (state.readOnly || !state.submissionId) return;
    const payload = collectPayload(state.descriptors, state.values);
    state.saveInFlight = true;
    state.dirty = false;
    setSaveStatus(silent ? "Saving…" : "Saving draft…");
    try {
      await apiFetch(`/reports/${state.submissionId}`, { method: "PATCH", body: { payload } });
      state.fieldErrors = {};
      state.formErrors = [];
      setSaveStatus(`Saved ${new Date().toLocaleTimeString()}`);
      renderFieldErrors();
    } catch (error) {
      const messages = parseApiErrorDetails(error);
      const mapped = applyServerErrors(state.descriptors, messages);
      state.fieldErrors = mapped.fieldErrors;
      state.formErrors = mapped.formErrors.length > 0 ? mapped.formErrors : messages;
      setSaveStatus("Save failed", { error: true });
      renderFieldErrors();
    } finally {
      state.saveInFlight = false;
      if (state.pendingAutosave) {
        state.pendingAutosave = false;
        scheduleAutosave();
      }
    }
  }

  async function submitReport({ reason } = {}) {
    if (state.readOnly || !state.submissionId) return;
    // Flush any edits still only in memory before validating a submit -- the
    // server validates whatever is already persisted on the row, not
    // whatever's in the request body.
    if (state.dirty) {
      await saveDraft();
      if (Object.keys(state.fieldErrors).length > 0) return;
    }
    setSaveStatus("Submitting…");
    try {
      const body = reason ? { reason } : {};
      const updated = await apiFetch(`/reports/${state.submissionId}/submit`, { method: "POST", body });
      state.status = (updated && updated.status) || "submitted";
      state.readOnly = true;
      state.needsReason = false;
      state.fieldErrors = {};
      state.formErrors = [];
      setSaveStatus("Submitted");
      render();
      await loadReports();
    } catch (error) {
      const messages = parseApiErrorDetails(error);
      // warn_and_submit templates (validation_json.submit_policy, see
      // reports-routes.mjs) reject a submit with validation warnings unless
      // a reason is supplied -- surface a reason box instead of treating
      // this like an ordinary field-validation failure.
      if (messages.some((message) => /reason is required/i.test(message))) {
        state.needsReason = true;
        state.formErrors = ["This report has validation warnings. Enter a reason to submit anyway."];
        setSaveStatus("Needs a reason", { error: true });
        render();
        return;
      }
      const mapped = applyServerErrors(state.descriptors, messages);
      state.fieldErrors = mapped.fieldErrors;
      state.formErrors = mapped.formErrors.length > 0 ? mapped.formErrors : messages;
      setSaveStatus("Submit failed", { error: true });
      renderFieldErrors();
    }
  }

  // photo/signature fields answer with a storage path, filled in by
  // uploading through the existing per-module attachments route (DR-09,
  // attachments-routes.mjs) tagged with this field's key via x-field-key so
  // it's traceable back to the question it answers.
  function buildFileFieldInput(descriptor) {
    const wrapper = el("div", { class: "report-field-file" });
    const value = state.values[descriptor.key];
    const status = el("span", { class: "item-subtitle" }, value ? "File on record for this field." : "No file uploaded yet.");
    wrapper.append(status);
    if (!state.readOnly) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = descriptor.type === "signature" ? "image/png,image/jpeg" : ATTACHMENT_ACCEPT;
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        status.textContent = "Uploading…";
        status.classList.remove("rr-error");
        try {
          const attachment = await uploadAttachmentFile(`/reports/${state.submissionId}/attachments`, file, {
            "x-field-key": descriptor.key
          });
          setFieldValue(descriptor.key, attachment.storage_path);
          status.textContent = `Uploaded ${file.name}.`;
        } catch (error) {
          status.textContent = `Error: ${error.message}`;
          status.classList.add("rr-error");
        }
      });
      wrapper.append(input);
    }
    return wrapper;
  }

  function buildFieldInput(descriptor) {
    const value = state.values[descriptor.key];
    const disabled = state.readOnly;
    const inputId = `${areaId}-field-${descriptor.key}`;

    if (descriptor.type === "photo" || descriptor.type === "signature") {
      return buildFileFieldInput(descriptor);
    }

    if (descriptor.type === "multiselect") {
      const wrapper = el("div", { class: "report-field-multiselect" });
      const current = Array.isArray(value) ? value : [];
      for (const option of descriptor.options || []) {
        const optionId = `${inputId}-${option}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = optionId;
        checkbox.value = option;
        checkbox.checked = current.includes(option);
        checkbox.disabled = disabled;
        checkbox.addEventListener("change", () => {
          const existing = Array.isArray(state.values[descriptor.key]) ? state.values[descriptor.key] : [];
          const next = checkbox.checked
            ? [...new Set([...existing, option])]
            : existing.filter((entry) => entry !== option);
          setFieldValue(descriptor.key, next);
        });
        wrapper.append(el("label", { class: "report-field-option", for: optionId }, [checkbox, ` ${option}`]));
      }
      return wrapper;
    }

    if (descriptor.type === "select") {
      const select = document.createElement("select");
      select.id = inputId;
      select.disabled = disabled;
      select.append(el("option", { value: "" }, "-- select --"));
      for (const option of descriptor.options || []) {
        const optionEl = el("option", { value: option }, option);
        if (value === option) optionEl.selected = true;
        select.append(optionEl);
      }
      select.addEventListener("change", () => setFieldValue(descriptor.key, select.value));
      return select;
    }

    if (descriptor.type === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = inputId;
      input.checked = value === true;
      input.disabled = disabled;
      input.addEventListener("change", () => setFieldValue(descriptor.key, input.checked));
      return input;
    }

    if (descriptor.type === "textarea") {
      const textarea = document.createElement("textarea");
      textarea.id = inputId;
      textarea.value = value ?? "";
      textarea.disabled = disabled;
      textarea.addEventListener("input", () => setFieldValue(descriptor.key, textarea.value));
      return textarea;
    }

    // text, number, date, time all render as a single <input> differing only
    // in `type`.
    const input = document.createElement("input");
    input.type = descriptor.type === "number" || descriptor.type === "date" || descriptor.type === "time"
      ? descriptor.type
      : "text";
    input.id = inputId;
    input.value = value ?? "";
    input.disabled = disabled;
    input.addEventListener("input", () => setFieldValue(descriptor.key, input.value));
    return input;
  }

  function buildFieldRow(descriptor) {
    const isGroup = descriptor.type === "multiselect" || descriptor.type === "photo" || descriptor.type === "signature";
    const row = el(isGroup ? "fieldset" : "div", { class: "report-field" });
    const labelText = `${descriptor.label}${descriptor.required ? " *" : ""}`;
    row.append(
      isGroup ? el("legend", {}, labelText) : el("label", { for: `${areaId}-field-${descriptor.key}` }, labelText)
    );
    row.append(buildFieldInput(descriptor));
    if (descriptor.helpText) row.append(el("span", { class: "item-subtitle" }, descriptor.helpText));
    const errorEl = el("div", { class: "field-error rr-error" });
    row.append(errorEl);
    state.fieldNodes.set(descriptor.key, { errorEl });
    return row;
  }

  function groupSections(descriptors) {
    const bySection = new Map();
    for (const descriptor of descriptors) {
      if (!bySection.has(descriptor.sectionIndex)) {
        bySection.set(descriptor.sectionIndex, { index: descriptor.sectionIndex, title: descriptor.sectionTitle, fields: [] });
      }
      bySection.get(descriptor.sectionIndex).fields.push(descriptor);
    }
    return [...bySection.values()].sort((a, b) => a.index - b.index);
  }

  function render() {
    const host = area();
    if (!host) return;
    host.textContent = "";
    state.fieldNodes = new Map();

    const header = el("div", { class: "report-form-header" });
    header.append(el("h3", {}, state.templateName || "Report"));
    const closeBtn = el("button", { type: "button" }, "Close");
    closeBtn.addEventListener("click", () => close());
    header.append(closeBtn);
    host.append(header);

    const banner = el("div", { class: "rr-error report-form-banner", id: `${areaId}-banner` });
    banner.hidden = state.formErrors.length === 0;
    for (const message of state.formErrors) banner.append(el("p", {}, message));
    host.append(banner);

    const sections = groupSections(state.descriptors);
    if (state.currentSectionIndex >= sections.length) state.currentSectionIndex = 0;

    if (sections.length > 1) {
      const nav = el("div", { class: "report-form-steps" });
      sections.forEach((section, index) => {
        const stepBtn = el(
          "button",
          { type: "button", class: index === state.currentSectionIndex ? "report-step-btn active" : "report-step-btn" },
          section.title || `Section ${index + 1}`
        );
        stepBtn.addEventListener("click", () => {
          state.currentSectionIndex = index;
          render();
        });
        nav.append(stepBtn);
      });
      host.append(nav);
    }

    const formEl = el("div", { class: "report-form" });
    const currentSection = sections[state.currentSectionIndex];
    if (currentSection) {
      if (currentSection.title) formEl.append(el("h4", {}, currentSection.title));
      for (const descriptor of currentSection.fields) formEl.append(buildFieldRow(descriptor));
    } else {
      formEl.append(el("p", {}, "This report template has no fields."));
    }
    host.append(formEl);

    if (sections.length > 1) {
      const stepNav = el("div", { class: "report-step-nav" });
      const prevBtn = el("button", { type: "button" }, "Back");
      prevBtn.disabled = state.currentSectionIndex === 0;
      prevBtn.addEventListener("click", () => {
        state.currentSectionIndex -= 1;
        render();
      });
      const nextBtn = el("button", { type: "button" }, "Next");
      nextBtn.disabled = state.currentSectionIndex >= sections.length - 1;
      nextBtn.addEventListener("click", () => {
        state.currentSectionIndex += 1;
        render();
      });
      stepNav.append(prevBtn, nextBtn);
      host.append(stepNav);
    }

    // Sticky Save draft / Submit action bar (see .report-form-actions in
    // styles.css) -- stays pinned to the bottom of the form area regardless
    // of which section/step is showing.
    const actionBar = el("div", { class: "report-form-actions" });
    actionBar.append(el("span", { class: "report-form-status", id: `${areaId}-status` }));
    if (editable && !state.readOnly) {
      const saveBtn = el("button", { type: "button" }, "Save draft");
      saveBtn.addEventListener("click", () => saveDraft());
      const submitBtn = el("button", { type: "button", class: "primary" }, "Submit");
      submitBtn.addEventListener("click", () => submitReport());
      actionBar.append(saveBtn, submitBtn);
      if (state.needsReason) {
        const reasonInput = document.createElement("textarea");
        reasonInput.className = "report-reason-input";
        reasonInput.placeholder = "Reason for submitting with warnings";
        const reasonBtn = el("button", { type: "button", class: "primary" }, "Submit with reason");
        reasonBtn.addEventListener("click", () => submitReport({ reason: reasonInput.value }));
        actionBar.append(reasonInput, reasonBtn);
      }
    } else {
      actionBar.append(el("span", { class: "item-subtitle" }, `Status: ${state.status || "unknown"}`));
    }
    host.append(actionBar);

    renderFieldErrors();

    if (typeof extra === "function") extra(host, state);
  }

  // Loads a submission via /reports/:id/detail -- the pinned-version schema
  // route -- so a template re-publish never relabels an already-open
  // submission (DR-14's acceptance highlight, but it benefits the DR-13 form
  // equally: a draft opened mid-edit keeps the labels it started with even
  // if an admin republishes the template in another tab).
  async function open(submissionId, { forceReadOnly = false } = {}) {
    const host = area();
    if (!host) return;
    if (state.autosaveTimer) {
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
    }
    host.hidden = false;
    host.textContent = "";
    host.append(el("p", {}, "Loading report…"));
    try {
      const detail = await apiFetch(`/reports/${submissionId}/detail`);
      state.submissionId = submissionId;
      state.templateName = detail.template_name || "Report";
      state.descriptors = fieldDescriptors(detail.schema_json);
      state.values = { ...((detail.submission && detail.submission.payload_json) || {}) };
      state.status = (detail.submission && detail.submission.status) || null;
      state.readOnly = !editable || forceReadOnly || state.status !== "draft";
      state.currentSectionIndex = 0;
      state.saveInFlight = false;
      state.dirty = false;
      state.pendingAutosave = false;
      state.needsReason = false;
      state.fieldErrors = {};
      state.formErrors = [];
      state.detail = detail;
      render();
    } catch (error) {
      host.textContent = "";
      host.append(el("p", { class: "rr-error" }, `Error loading report: ${error.message}`));
    }
  }

  function close() {
    if (state.autosaveTimer) {
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
    }
    const host = area();
    if (host) {
      host.hidden = true;
      host.textContent = "";
    }
    state.submissionId = null;
  }

  return { open, close };
}

// DR-13's fill-a-draft form, mounted in the Daily reports panel.
const reportFormController = createReportFormController({ areaId: "report-form-area", editable: true });

// DR-14's manager review inbox detail pane: always read-only, and renders
// attachments/validation results/PDF export after the shared field-answer
// view via the `extra` hook.
const inboxDetailController = createReportFormController({
  areaId: "report-inbox-detail",
  editable: false,
  extra: renderInboxExtras
});

function renderInboxExtras(host, state) {
  const detail = state.detail;
  if (!detail) return;
  const submission = detail.submission || {};

  const meta = el("div", { class: "report-inbox-meta" });
  meta.append(el("p", { class: "item-subtitle" }, `Report date: ${submission.report_date || "-"}`));
  if (submission.submitted_at) {
    meta.append(el("p", { class: "item-subtitle" }, `Submitted ${new Date(submission.submitted_at).toLocaleString()}`));
  }
  host.append(meta);

  // warn_and_submit submissions carry {warnings, reason} on validation_results
  // (reports-routes.mjs's submit handler) -- surface both so a reviewer sees
  // exactly what was overridden and why.
  const warnings = submission.validation_results && Array.isArray(submission.validation_results.warnings)
    ? submission.validation_results.warnings
    : [];
  if (warnings.length > 0) {
    const box = el("div", { class: "report-validation-warnings" });
    box.append(el("strong", {}, "Submitted with validation warnings"));
    for (const warning of warnings) box.append(el("p", {}, warning));
    if (submission.validation_results.reason) {
      box.append(el("p", { class: "item-subtitle" }, `Reason: ${submission.validation_results.reason}`));
    }
    host.append(box);
  }

  const attachments = detail.attachments || [];
  const attachSection = el("div", { class: "report-inbox-attachments" });
  attachSection.append(el("strong", {}, "Attachments"));
  if (attachments.length === 0) {
    attachSection.append(el("p", { class: "item-subtitle" }, "No attachments."));
  } else {
    const list = el("ul", { class: "attachments-items" });
    for (const attachment of attachments) {
      const item = el("li", { class: "attachment-item" });
      const label = attachment.field_key
        ? `${attachment.field_key} · ${attachment.mime_type || "file"}`
        : attachment.mime_type || "file";
      item.append(el("span", {}, label));
      const downloadBtn = el("button", { type: "button" }, "Download");
      downloadBtn.addEventListener("click", () => downloadAttachment("reports", attachment.id));
      item.append(downloadBtn);
      list.append(item);
    }
    attachSection.append(list);
  }
  host.append(attachSection);

  const pdfSection = el("div", { class: "report-inbox-pdf" });
  const pdfStatus = el("span", { class: "item-subtitle" });
  const pdfBtn = el("button", { type: "button" }, "Download PDF");
  pdfBtn.addEventListener("click", () => downloadReportPdf(submission.id, pdfBtn, pdfStatus));
  pdfSection.append(pdfBtn, pdfStatus);
  host.append(pdfSection);
}

// GET /reports/:id/pdf (DR-15, landing this batch from a sibling agent) hands
// back the same {contentType, filename, body[, encoding]} export envelope
// every other export route in this codebase uses (see
// src/lib/http/audit-routes.mjs and admin/js/pages/export.js) because the
// shared sendJson primitive can only ever emit application/json -- so the
// download itself has to be completed client-side: decode `body` (base64 for
// binary formats), wrap it in a same-typed Blob, and click a throwaway
// object-URL anchor. If the route isn't wired yet, or the caller lacks
// reports.export, apiFetch's normal error handling surfaces the 404/403 as
// `error.message`, shown inline instead of a silent failure.
async function downloadReportPdf(submissionId, button, statusEl) {
  button.disabled = true;
  statusEl.classList.remove("rr-error");
  statusEl.textContent = "Preparing PDF…";
  try {
    const pkg = await apiFetch(`/reports/${submissionId}/pdf`);
    if (!pkg || typeof pkg.body !== "string") throw new Error("PDF export returned no data");
    const bytes = pkg.encoding === "base64" ? base64ToBytes(pkg.body) : pkg.body;
    const blob = new Blob([bytes], { type: pkg.contentType || "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = pkg.filename || `report-${submissionId}.pdf`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    statusEl.textContent = `Downloaded ${pkg.filename || "report.pdf"}.`;
  } catch (error) {
    statusEl.classList.add("rr-error");
    statusEl.textContent = `PDF export unavailable: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Manager review inbox (DR-14) -------------------------------------------
// Filter bar (status/date range/department/template) driving GET
// /facilities/:id/reports' query params, a list of matching submissions, and
// a detail pane (inboxDetailController above) rendering labeled answers from
// each submission's pinned schema.

function buildReportsQuery() {
  const params = new URLSearchParams();
  const status = document.getElementById("report-filter-status")?.value;
  const from = document.getElementById("report-filter-from")?.value;
  const to = document.getElementById("report-filter-to")?.value;
  const departmentId = document.getElementById("report-filter-department")?.value;
  const templateId = document.getElementById("report-filter-template")?.value;
  if (status) params.set("status", status);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (departmentId) params.set("department_id", departmentId);
  if (templateId) params.set("template_id", templateId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function setupReportInboxFilters() {
  const form = document.getElementById("report-inbox-filters");
  if (!form || form.dataset.wired === "true") return;
  form.dataset.wired = "true";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    inboxDetailController.close();
    loadReportInboxList();
  });
}

// Template options always come back (reports.read is enough for
// ?status=all); the department dropdown is best-effort -- GET
// /facilities/:id/departments is gated on admin.manage (admin-routes.mjs),
// which a reports reviewer may not hold, so a 403 there just leaves the
// dropdown at its default "All" option instead of breaking the rest of the
// filter bar.
async function refreshReportInboxFilterOptions() {
  if (!currentFacility) return;
  const templateSelect = document.getElementById("report-filter-template");
  const departmentSelect = document.getElementById("report-filter-department");

  try {
    const templates = await apiFetch(`/facilities/${currentFacility}/report-templates?status=all`);
    reportTemplatesById = new Map((templates || []).map((template) => [template.id, template.name]));
    if (templateSelect) {
      templateSelect.textContent = "";
      templateSelect.append(el("option", { value: "" }, "All templates"));
      for (const template of templates || []) {
        templateSelect.append(el("option", { value: template.id }, template.name));
      }
    }
  } catch (error) {
    console.error("Failed to load report templates for filters:", error);
  }

  if (departmentSelect) {
    departmentSelect.textContent = "";
    departmentSelect.append(el("option", { value: "" }, "All departments"));
    try {
      const departments = await apiFetch(`/facilities/${currentFacility}/departments`);
      for (const department of departments || []) {
        departmentSelect.append(el("option", { value: department.id }, department.name));
      }
    } catch {
      // Best-effort -- see comment above.
    }
  }
}

function renderReportInboxList(container, rows) {
  container.textContent = "";
  if (rows.length === 0) {
    container.append(el("p", {}, "No submissions match these filters."));
    return;
  }
  for (const row of rows) {
    const item = el("div", { class: "module-item" });
    const templateName = reportTemplatesById.get(row.template_id) || "Report";
    item.append(el("div", { class: "item-title" }, `${templateName} · ${row.status} · ${row.report_date}`));
    if (row.submitted_at) {
      item.append(el("div", { class: "item-subtitle" }, `Submitted ${new Date(row.submitted_at).toLocaleString()}`));
    }
    const viewBtn = el("button", { type: "button", class: "primary" }, "View");
    viewBtn.addEventListener("click", () => inboxDetailController.open(row.id, { forceReadOnly: true }));
    item.append(viewBtn);
    container.append(item);
  }
}

async function loadReportInboxList() {
  const container = document.getElementById("report-inbox-list");
  if (!container || !currentFacility) return;
  setLoading(container, true);
  try {
    const rows = await apiFetch(`/facilities/${currentFacility}/reports${buildReportsQuery()}`);
    renderReportInboxList(container, rows || []);
  } catch (error) {
    setError(container, error.message);
  }
}

async function loadReportInbox() {
  if (!document.getElementById("report-inbox-list")) return;
  setupReportInboxFilters();
  await refreshReportInboxFilterOptions();
  await loadReportInboxList();
}

// Schedule module
async function loadSchedule() {
  const container = document.getElementById("schedule-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const shifts = await apiFetch(`/facilities/${currentFacility}/shifts`);
    const shiftsData = shifts || [];

    if (shiftsData.length === 0) {
      container.innerHTML = '<p>No shifts scheduled.</p>';
      return;
    }

    let html = "";
    for (const shift of shiftsData.slice(0, 5)) {
      const startTime = new Date(shift.starts_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      const endTime = new Date(shift.ends_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      html += '<article class="shift-item">';
      html += `<strong>${escapeHtml(shift.shift_date)} · ${startTime}–${endTime}</strong>`;
      html += `<span class="item-subtitle">${escapeHtml(shift.role_code)}</span>`;
      html += '</article>';
    }

    html += '<button type="button" class="primary schedule-validate-btn" id="validate-schedule-btn">Validate schedule</button>';
    container.innerHTML = html;

    const validateBtn = document.getElementById("validate-schedule-btn");
    if (validateBtn) {
      validateBtn.addEventListener("click", validateSchedule);
    }
  } catch (error) {
    setError(container, error.message);
  }
}

async function validateSchedule() {
  if (!currentFacility) return;
  try {
    const result = await apiFetch(`/facilities/${currentFacility}/schedule/validate`, {
      method: "POST"
    });

    const container = document.getElementById("schedule-list");
    if (container) {
      let html = '<div class="validation-result">';
      html += result.canPublish
        ? '<div class="validation-success">✓ Schedule is ready to publish</div>'
        : '<div class="validation-error">✗ Schedule has issues</div>';

      if (result.doubleBookings && result.doubleBookings.length > 0) {
        html += '<div class="validation-issues"><strong>Double bookings:</strong>';
        for (const booking of result.doubleBookings) {
          html += `<div class="issue-item">Employee ${escapeHtml(booking.employeeId)}</div>`;
        }
        html += '</div>';
      }

      html += '</div>';

      const scheduleList = container.querySelector("article") || container;
      scheduleList.insertAdjacentHTML("beforebegin", html);
    }
  } catch (error) {
    console.error("Validation failed:", error);
  }
}

// Incidents module
async function loadIncidents() {
  const container = document.getElementById("incidents-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const incidents = await apiFetch(`/facilities/${currentFacility}/incidents`);
    const incidentsData = incidents || [];

    if (incidentsData.length === 0) {
      container.innerHTML = '<p>No incidents reported.</p>';
      return;
    }

    let html = "";
    for (const incident of incidentsData.slice(0, 5)) {
      html += '<div class="incident-card">';
      html += `<strong>${escapeHtml(incident.incident_no)} · ${escapeHtml(incident.report_type)} · ${escapeHtml(incident.severity)}</strong>`;
      html += `<div class="item-subtitle">${escapeHtml(incident.location_text)}</div>`;
      html += `<div class="item-subtitle">${escapeHtml(incident.summary)}</div>`;
      if (incident.requires_osha_review) {
        html += '<div class="osha-warning">OSHA review required</div>';
      }
      html += attachmentsToggleMarkup("incidents", incident.id);
      html += '</div>';
    }

    container.innerHTML = html;
    wireAttachmentToggles(container);
  } catch (error) {
    setError(container, error.message);
  }
}

// Work orders module
async function loadWorkOrders() {
  const container = document.getElementById("work-orders-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const workOrders = await apiFetch(`/facilities/${currentFacility}/work-orders`);
    const workOrdersData = workOrders || [];

    if (workOrdersData.length === 0) {
      container.innerHTML = '<p>No work orders.</p>';
      return;
    }

    let html = "";
    for (const wo of workOrdersData.slice(0, 5)) {
      html += '<div class="work-order-card">';
      html += `<strong>${escapeHtml(wo.priority)} · ${escapeHtml(wo.title)}</strong>`;
      html += `<div class="item-subtitle">${escapeHtml(wo.description)}</div>`;
      if (wo.due_at) {
        html += `<div class="item-subtitle">Due ${new Date(wo.due_at).toLocaleDateString()}</div>`;
      }
      html += attachmentsToggleMarkup("work-orders", wo.id);
      html += '</div>';
    }

    container.innerHTML = html;
    wireAttachmentToggles(container);
  } catch (error) {
    setError(container, error.message);
  }
}

// Messages module
async function loadMessages() {
  const container = document.getElementById("messages-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const messages = await apiFetch(`/facilities/${currentFacility}/messages`);
    const messagesData = messages || [];

    if (messagesData.length === 0) {
      container.innerHTML = '<p>No messages.</p>';
      return;
    }

    let html = "";
    for (const message of messagesData.slice(0, 5)) {
      html += '<div class="message-card">';
      html += `<strong>${escapeHtml(message.priority)} · ${escapeHtml(message.subject)}</strong>`;
      html += `<div class="item-subtitle">${escapeHtml(message.body_text.substring(0, 100))}</div>`;
      if (message.is_required_ack) {
        html += `<button type="button" class="ack-btn primary message-action-btn" data-message-id="${escapeHtml(message.id)}">Acknowledge</button>`;
      }
      html += '</div>';
    }

    container.innerHTML = html;

    // Wire acknowledge buttons
    document.querySelectorAll(".ack-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const messageId = e.target.getAttribute("data-message-id");
        await acknowledgeMessage(messageId);
      });
    });
  } catch (error) {
    setError(container, error.message);
  }
}

async function acknowledgeMessage(messageId) {
  try {
    await apiFetch(`/messages/${messageId}/acknowledge`, { method: "POST" });
    await loadMessages();
  } catch (error) {
    console.error("Failed to acknowledge message:", error);
  }
}

// Training module
async function loadTraining() {
  const container = document.getElementById("training-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const assignments = await apiFetch(`/facilities/${currentFacility}/training-assignments`);
    const assignmentsData = assignments || [];

    if (assignmentsData.length === 0) {
      container.innerHTML = '<p>No training assignments.</p>';
      return;
    }

    let html = "";
    for (const assignment of assignmentsData.slice(0, 5)) {
      html += '<div class="training-card">';
      html += '<div class="item-title">Training assignment</div>';
      if (assignment.due_at) {
        html += `<div class="item-subtitle">Due ${new Date(assignment.due_at).toLocaleDateString()}</div>`;
      }
      html += `<button type="button" class="complete-btn primary training-action-btn" data-assignment-id="${escapeHtml(assignment.id)}">Mark complete</button>`;
      html += '</div>';
    }

    container.innerHTML = html;

    // Wire complete buttons
    document.querySelectorAll(".complete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const assignmentId = e.target.getAttribute("data-assignment-id");
        await completeTraining(assignmentId);
      });
    });
  } catch (error) {
    setError(container, error.message);
  }
}

async function completeTraining(assignmentId) {
  try {
    await apiFetch(`/training-assignments/${assignmentId}/complete`, {
      method: "POST",
      body: { completionStatus: "passed" }
    });
    await loadTraining();
  } catch (error) {
    console.error("Failed to mark training complete:", error);
  }
}

// Certification wallet module
async function loadCertifications() {
  const container = document.getElementById("certifications-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const certifications = await apiFetch(`/facilities/${currentFacility}/employee-certifications`);
    const certData = certifications || [];

    if (certData.length === 0) {
      container.innerHTML = '<p>No certifications on file.</p>';
      return;
    }

    let html = "";
    for (const cert of certData) {
      html += '<div class="module-item">';
      html += `<div class="item-title">${escapeHtml(cert.certification_type_name || cert.certification_type_code || "Certification")}</div>`;
      html += `<div class="item-subtitle">Status: ${escapeHtml(cert.status)}</div>`;
      if (cert.expires_at) {
        html += `<div class="item-subtitle">Expires ${new Date(cert.expires_at).toLocaleDateString()}</div>`;
      }
      html += `<div class="item-subtitle">Evidence: ${cert.evidence_path ? "on file" : "not uploaded"}</div>`;
      html += '</div>';
    }

    container.innerHTML = html;
  } catch (error) {
    setError(container, error.message);
  }
}

// Helper: Set loading state
function setLoading(container, loading) {
  if (loading) {
    container.innerHTML = '<p>Loading...</p>';
  }
}

// Helper: Set error state
function setError(container, message) {
  container.innerHTML = `<p class="rr-error">Error: ${escapeHtml(message)}</p>`;
}

// Helper: Escape HTML
function escapeHtml(text) {
  if (!text) return "";
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

// Sign out handler
function setupSignOut() {
  const signOutBtn = document.getElementById("sign-out-btn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", () => {
      clearAuthAndRedirect();
    });
  }
}

// Start app on load
document.addEventListener("DOMContentLoaded", () => {
  setupSignOut();
  initialize();
});
