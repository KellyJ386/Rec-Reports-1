import { fieldDescriptors, collectPayload, applyServerErrors } from "./report-form.mjs";
import {
  severityRequiresGating,
  validateIncidentCapture,
  buildIncidentCreatePayload,
  validateFollowupInput,
  buildFollowupPayload,
  validateAmendmentInput,
  buildAmendmentPayload,
  nextEscalationAction,
  INCIDENT_REPORT_TYPES,
  INCIDENT_SEVERITIES,
  FOLLOWUP_ACTION_TYPES,
  AMENDABLE_INCIDENT_FIELDS
} from "./incident-form.mjs";
import { paginate } from "./list-pagination.mjs";
import {
  WORK_ORDER_STATUSES,
  WORK_ORDER_PRIORITIES,
  buildWorkOrderQuery,
  validateWorkOrderCreate,
  buildWorkOrderCreatePayload
} from "./work-order-filters.mjs";
import { weekBoundsFor, bucketShiftsByDay, deriveShiftBadges, validateShiftCreate, buildShiftCreatePayload } from "./schedule-board.mjs";
import {
  MESSAGE_PRIORITIES,
  AUDIENCE_TYPES,
  validateComposeInput,
  buildComposePayload,
  validateAudienceRows,
  buildAudiencePayload,
  deriveAckState
} from "./comms-compose.mjs";

const TOKEN_KEY = "rr_admin_token";
const REFRESH_TOKEN_KEY = "rr_refresh_token";
const API_BASE = "/api/v1";

// State
let currentUser = null;
let currentFacility = null;
let facilities = [];
let platformAdmin = false;
let reportTemplatesById = new Map();

// Permission gating: a user without the relevant write permission must never
// see write controls (rule applies to every panel added this batch). Platform
// admins bypass every permission check server-side (0022) but GET /me only
// ever populates a facility's `permissions` array from real membership rows
// (src/lib/http/me-route.mjs), which can be empty for a platform admin with
// no membership in a given facility -- so the client-side gate below mirrors
// that bypass explicitly rather than hiding controls a platform admin's
// requests would actually be allowed to make.
function currentFacilityRecord() {
  return facilities.find((f) => f.id === currentFacility) || null;
}

function hasPerm(code) {
  if (platformAdmin) return true;
  const facility = currentFacilityRecord();
  return !!facility && Array.isArray(facility.permissions) && facility.permissions.includes(code);
}

// Renders a 403 (or any) error as an inline message inside `container`
// instead of leaving a panel broken/blank -- the shared failure mode every
// write action in this batch's panels routes through.
function renderInlineError(container, error) {
  container.textContent = "";
  container.append(el("p", { class: "rr-error" }, `Error: ${error && error.message ? error.message : "request failed"}`));
}

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

// Helper: Exchange the stored refresh token for a new session. Single-flight,
// because several calls can 401 at once when the access token expires and the
// refresh token is single-use. Resolves true when a fresh token was stored.
let refreshInFlight = null;

async function exchangeRefreshToken() {
  let refreshToken = "";
  try {
    refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY) || "";
  } catch {
    return false;
  }
  if (!refreshToken) return false;

  let response;
  try {
    response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  let session;
  try {
    session = await response.json();
  } catch {
    return false;
  }
  if (!session || !session.access_token) return false;

  try {
    localStorage.setItem(TOKEN_KEY, session.access_token);
    if (session.refresh_token) {
      localStorage.setItem(REFRESH_TOKEN_KEY, session.refresh_token);
    }
  } catch {
    return false;
  }
  return true;
}

function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = exchangeRefreshToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Helper: Fetch with bearer token and JSON handling
async function apiFetch(path, options = {}) {
  // Serialize the body once, outside the send helper, so a retry after a token
  // refresh doesn't stringify an already-stringified body.
  const requestOptions = { ...options };
  const baseHeaders = { "Accept": "application/json", ...options.headers };
  if (requestOptions.body && typeof requestOptions.body === "object") {
    baseHeaders["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  async function send() {
    const token = getToken();
    const headers = { ...baseHeaders };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    try {
      return await fetch(`${API_BASE}${path}`, { ...requestOptions, headers });
    } catch (error) {
      throw new Error(`Network error: ${error.message}`);
    }
  }

  let response = await send();

  // An expired access token gets one silent refresh and one replay before the
  // user is bounced to the sign-in page.
  if (response.status === 401 && (await refreshSession())) {
    response = await send();
  }

  if (response.status === 401) {
    clearAuthAndRedirect();
    return null;
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
    platformAdmin = meData.platformAdmin === true;

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

  // A report form, inbox detail pane, or any of this batch's detail/compose
  // panels left open belongs to whichever facility it was opened under --
  // close them all before switching so a (re)load never leaves a stale
  // cross-facility view on screen.
  reportFormController.close();
  inboxDetailController.close();
  incidentsPanel.reset();
  workOrdersPanel.reset();
  schedulePanel.reset();
  commsPanel.reset();

  try {
    await Promise.all([
      loadReports(),
      loadReportInbox(),
      schedulePanel.load(),
      incidentsPanel.load(),
      workOrdersPanel.load(),
      commsPanel.load(),
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

// Builds a Prev/Next pagination bar from a list-pagination.mjs `paginate()`
// result. Shared by every client-side-paginated panel (incidents,
// escalations/follow-ups/amendments, messages) as well as the work orders
// panel's server-paginated list (WO-05) -- callers there pass an equivalent
// { page, totalPages, hasPrev, hasNext } shape built from the response's
// known page size rather than list-pagination.mjs's paginate(), since that
// list is already server-sliced.
// `info` is either a full list-pagination.mjs paginate() result (carries
// totalPages, so the label reads "Page X of Y") or a lighter
// { page, hasPrev, hasNext } shape a server-paginated panel builds by hand
// (work orders: GET .../work-orders has no total-count response, so hasNext
// is inferred from "did this page come back full" rather than a known page
// count -- see workOrdersPanel's loadList). Renders nothing when there is
// only ever one page either way.
function buildPaginationBar(info, onPageChange) {
  if (!info) return null;
  const knowsTotal = info.totalPages !== undefined;
  if (knowsTotal && info.totalPages <= 1) return null;
  if (!knowsTotal && !info.hasPrev && !info.hasNext) return null;

  const bar = el("div", { class: "pagination-bar" });
  const prevBtn = el("button", { type: "button" }, "Prev");
  prevBtn.disabled = !info.hasPrev;
  prevBtn.addEventListener("click", () => onPageChange(info.page - 1));
  const nextBtn = el("button", { type: "button" }, "Next");
  nextBtn.disabled = !info.hasNext;
  nextBtn.addEventListener("click", () => onPageChange(info.page + 1));
  const label = knowsTotal ? `Page ${info.page} of ${info.totalPages}` : `Page ${info.page}`;
  bar.append(prevBtn, el("span", { class: "pagination-status" }, label), nextBtn);
  return bar;
}

// Renders a labeled badge span (conflict/cert/ack-state indicators used by
// the schedule board and communications panels).
function badge(text, variant) {
  return el("span", { class: `badge badge-${variant}` }, text);
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

// --- Schedule board (SC-08) --------------------------------------------------
// Week picker, day-column shift grid, assign/unassign, create-shift form,
// generate-from-templates, and Validate/Publish with readiness badges.
//
// Known API gap, worked around rather than papered over: nothing in
// src/lib/http/scheduling-routes.mjs lists existing shift_assignments (only
// POST to create one and PATCH to change its status exist) -- so the board
// can only ever know about an assignment IT created or changed this session.
// assignmentsByShiftId is that session-local cache; a shift assigned in
// another tab/session, or before this page loaded, renders as "Unassigned"
// with an honest caption rather than a guess.
const schedulePanel = (function () {
  const state = {
    weekStartDate: null,
    periods: [],
    period: null,
    shifts: [],
    employees: [],
    readiness: null,
    assignmentsByShiftId: new Map(),
    createShiftOpen: false,
    createPeriodBusy: false,
    formError: null
  };

  function container() {
    return document.getElementById("schedule-workspace");
  }

  function employeeLabel(employeeId) {
    const employee = state.employees.find((e) => e.id === employeeId);
    return employee ? `${employee.first_name} ${employee.last_name}` : employeeId;
  }

  async function load() {
    const host = container();
    if (!host || !currentFacility) return;
    if (!state.weekStartDate) {
      state.weekStartDate = weekBoundsFor(new Date().toISOString().slice(0, 10)).weekStartDate;
    }
    setLoading(host, true);
    try {
      const [periods, employees] = await Promise.all([
        apiFetch(`/facilities/${currentFacility}/schedule-periods`),
        apiFetch(`/facilities/${currentFacility}/employees`).catch(() => [])
      ]);
      state.periods = periods || [];
      state.employees = employees || [];
      await reloadWeek();
    } catch (error) {
      renderInlineError(host, error);
    }
  }

  async function reloadWeek() {
    state.period = state.periods.find((p) => p.week_start_date === state.weekStartDate && !p.department_id) || null;
    state.readiness = null;
    state.assignmentsByShiftId = new Map();
    if (state.period) {
      try {
        state.shifts = (await apiFetch(`/facilities/${currentFacility}/shifts?period_id=${state.period.id}`)) || [];
        state.formError = null;
      } catch (error) {
        state.shifts = [];
        state.formError = error.message;
      }
    } else {
      state.shifts = [];
    }
    render();
  }

  function reset() {
    state.createShiftOpen = false;
    state.readiness = null;
    state.formError = null;
    state.assignmentsByShiftId = new Map();
    const host = container();
    if (host) host.textContent = "";
  }

  function changeWeek(deltaDays) {
    const [y, m, d] = state.weekStartDate.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + deltaDays);
    state.weekStartDate = weekBoundsFor(date.toISOString().slice(0, 10)).weekStartDate;
    reloadWeek();
  }

  async function createPeriod() {
    if (!hasPerm("schedule.manage") || state.createPeriodBusy) return;
    const { weekStartDate, weekEndDate } = weekBoundsFor(state.weekStartDate);
    state.createPeriodBusy = true;
    render();
    try {
      const created = await apiFetch(`/facilities/${currentFacility}/schedule-periods`, {
        method: "POST",
        body: { weekStartDate, weekEndDate }
      });
      state.periods.push(created);
      state.createPeriodBusy = false;
      await reloadWeek();
    } catch (error) {
      state.createPeriodBusy = false;
      state.formError = error.message;
      render();
    }
  }

  async function generateFromTemplates() {
    if (!state.period || !hasPerm("schedule.manage")) return;
    try {
      const result = await apiFetch(`/facilities/${currentFacility}/schedule-periods/${state.period.id}/generate`, {
        method: "POST"
      });
      state.shifts = state.shifts.concat(result.inserted || []);
      state.formError = null;
      render();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function runValidate() {
    if (!state.period) return;
    try {
      const result = await apiFetch(`/facilities/${currentFacility}/schedule/validate?period_id=${state.period.id}`, {
        method: "POST"
      });
      state.readiness = result;
      state.formError = null;
      render();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function runPublish() {
    if (!state.period || !hasPerm("schedule.publish")) return;
    try {
      const result = await apiFetch(`/facilities/${currentFacility}/schedule-periods/${state.period.id}/publish`, {
        method: "POST"
      });
      state.period = result.period || state.period;
      const idx = state.periods.findIndex((p) => p.id === state.period.id);
      if (idx >= 0) state.periods[idx] = state.period;
      state.formError = null;
      render();
    } catch (error) {
      // A blocking-readiness 409 body carries the same shape
      // /schedule/validate returns -- reuse it so the badges stay accurate.
      if (error.details && Array.isArray(error.details.doubleBookings)) {
        state.readiness = error.details;
      }
      state.formError = error.message;
      render();
    }
  }

  async function assignEmployee(shiftId, employeeId) {
    if (!employeeId) return;
    try {
      const assignment = await apiFetch(`/facilities/${currentFacility}/shifts/${shiftId}/assignments`, {
        method: "POST",
        body: { employeeId }
      });
      state.assignmentsByShiftId.set(shiftId, {
        id: assignment.id,
        employeeId: assignment.employee_id,
        label: employeeLabel(assignment.employee_id)
      });
      state.formError = null;
      render();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function unassign(shiftId) {
    const assignment = state.assignmentsByShiftId.get(shiftId);
    if (!assignment) return;
    try {
      await apiFetch(`/facilities/${currentFacility}/shifts/${shiftId}/assignments/${assignment.id}`, {
        method: "PATCH",
        body: { status: "cancelled" }
      });
      state.assignmentsByShiftId.delete(shiftId);
      render();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  function buildCreateShiftForm() {
    const fields = { roleCode: "", shiftDate: state.weekStartDate, startsAt: "", endsAt: "" };
    const wrap = el("div", { class: "inline-form" });
    const roleInput = el("input", { type: "text", placeholder: "Role code (e.g. lifeguard)" });
    roleInput.addEventListener("input", () => (fields.roleCode = roleInput.value));
    const dateInput = el("input", { type: "date", value: state.weekStartDate });
    dateInput.addEventListener("input", () => (fields.shiftDate = dateInput.value));
    const startInput = el("input", { type: "datetime-local" });
    startInput.addEventListener("input", () => {
      fields.startsAt = startInput.value ? new Date(startInput.value).toISOString() : "";
    });
    const endInput = el("input", { type: "datetime-local" });
    endInput.addEventListener("input", () => {
      fields.endsAt = endInput.value ? new Date(endInput.value).toISOString() : "";
    });
    const errorEl = el("p", { class: "rr-error" });
    const submitBtn = el("button", { type: "button", class: "primary" }, "Add shift");
    submitBtn.addEventListener("click", async () => {
      const validation = validateShiftCreate(fields);
      if (!validation.valid) {
        errorEl.textContent = Object.values(validation.errors).join(" ");
        return;
      }
      try {
        const created = await apiFetch(`/facilities/${currentFacility}/shifts`, {
          method: "POST",
          body: buildShiftCreatePayload({ ...fields, schedulePeriodId: state.period.id })
        });
        state.shifts.push(created);
        state.createShiftOpen = false;
        render();
      } catch (error) {
        errorEl.textContent = error.message;
      }
    });
    wrap.append(
      el("label", {}, ["Role", roleInput]),
      el("label", {}, ["Date", dateInput]),
      el("label", {}, ["Starts", startInput]),
      el("label", {}, ["Ends", endInput]),
      submitBtn,
      errorEl
    );
    return wrap;
  }

  function buildShiftCard(shift, readiness) {
    const badges = deriveShiftBadges(shift.id, readiness || {});
    const card = el("article", { class: "shift-card" });
    const start = new Date(shift.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const end = new Date(shift.ends_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    card.append(el("strong", {}, `${shift.role_code} · ${start}–${end}`));

    const badgeRow = el("div", { class: "badge-row" });
    if (badges.conflict) badgeRow.append(badge("Double-booked", "danger"));
    if (badges.certBlocking) badgeRow.append(badge("Missing cert", "danger"));
    if (badges.certWarning) badgeRow.append(badge("Cert warning", "warning"));
    if (badgeRow.childNodes.length > 0) card.append(badgeRow);

    const assignment = state.assignmentsByShiftId.get(shift.id);
    if (assignment) {
      card.append(el("span", { class: "item-subtitle" }, `Assigned: ${assignment.label}`));
      if (hasPerm("schedule.manage")) {
        const unassignBtn = el("button", { type: "button" }, "Unassign");
        unassignBtn.addEventListener("click", () => unassign(shift.id));
        card.append(unassignBtn);
      }
    } else {
      card.append(el("span", { class: "item-subtitle" }, "Unassigned (or assigned outside this session)"));
      if (hasPerm("schedule.manage") && state.employees.length > 0) {
        const select = document.createElement("select");
        select.append(el("option", { value: "" }, "Assign to…"));
        for (const employee of state.employees) {
          select.append(el("option", { value: employee.id }, `${employee.first_name} ${employee.last_name}`));
        }
        select.addEventListener("change", () => {
          const employeeId = select.value;
          select.value = "";
          assignEmployee(shift.id, employeeId);
        });
        card.append(select);
      }
    }
    return card;
  }

  function render() {
    const host = container();
    if (!host) return;
    host.textContent = "";

    const picker = el("div", { class: "schedule-week-picker" });
    const prevBtn = el("button", { type: "button" }, "◀ Prev week");
    prevBtn.addEventListener("click", () => changeWeek(-7));
    const nextBtn = el("button", { type: "button" }, "Next week ▶");
    nextBtn.addEventListener("click", () => changeWeek(7));
    const dateInput = el("input", { type: "date", value: state.weekStartDate });
    dateInput.addEventListener("change", () => {
      state.weekStartDate = weekBoundsFor(dateInput.value).weekStartDate;
      reloadWeek();
    });
    picker.append(prevBtn, el("label", {}, ["Week of", dateInput]), nextBtn);
    host.append(picker);

    if (state.formError) host.append(el("p", { class: "rr-error" }, state.formError));

    if (!state.period) {
      const empty = el("div", { class: "module-item" });
      empty.append(el("p", {}, `No schedule period exists yet for the week of ${state.weekStartDate}.`));
      if (hasPerm("schedule.manage")) {
        const createBtn = el(
          "button",
          { type: "button", class: "primary" },
          state.createPeriodBusy ? "Creating…" : "Create schedule period"
        );
        createBtn.disabled = state.createPeriodBusy;
        createBtn.addEventListener("click", () => createPeriod());
        empty.append(createBtn);
      }
      host.append(empty);
      return;
    }

    const actions = el("div", { class: "schedule-actions" });
    actions.append(
      el("span", { class: "item-subtitle" }, `Period status: ${state.period.status} · publish v${state.period.publish_version ?? 0}`)
    );
    if (hasPerm("schedule.manage")) {
      const generateBtn = el("button", { type: "button" }, "Generate from templates");
      generateBtn.addEventListener("click", () => generateFromTemplates());
      actions.append(generateBtn);
    }
    const validateBtn = el("button", { type: "button" }, "Validate");
    validateBtn.addEventListener("click", () => runValidate());
    actions.append(validateBtn);
    if (hasPerm("schedule.publish")) {
      const publishBtn = el("button", { type: "button", class: "primary" }, "Publish");
      publishBtn.addEventListener("click", () => runPublish());
      actions.append(publishBtn);
    }
    if (hasPerm("schedule.manage")) {
      const toggleBtn = el("button", { type: "button" }, state.createShiftOpen ? "Cancel new shift" : "Add shift");
      toggleBtn.addEventListener("click", () => {
        state.createShiftOpen = !state.createShiftOpen;
        render();
      });
      actions.append(toggleBtn);
    }
    host.append(actions);

    if (state.createShiftOpen) host.append(buildCreateShiftForm());

    if (state.readiness) {
      const panel = el("div", { class: "validation-result" });
      panel.append(
        el(
          "div",
          { class: state.readiness.canPublish ? "validation-success" : "validation-error" },
          state.readiness.canPublish ? "✓ Ready to publish" : "✗ Not ready to publish"
        )
      );
      const warnings = state.readiness.warnings || [];
      if (warnings.length > 0) {
        panel.append(el("p", { class: "item-subtitle" }, `${warnings.length} certification warning(s) (non-blocking).`));
      }
      host.append(panel);
    }

    const board = el("div", { class: "schedule-board" });
    const days = bucketShiftsByDay(state.shifts, state.weekStartDate);
    for (const day of days) {
      const column = el("div", { class: "schedule-day-column" });
      column.append(el("h4", {}, `${day.weekday} ${day.date}`));
      if (day.shifts.length === 0) {
        column.append(el("p", { class: "item-subtitle" }, "No shifts."));
      } else {
        for (const shift of day.shifts) column.append(buildShiftCard(shift, state.readiness));
      }
      board.append(column);
    }
    host.append(board);
  }

  return { load, reset };
})();

// --- Incidents module (IN-10) -------------------------------------------------
// Capture form (draft -> submit), paginated list, and a detail view: status +
// submit/status actions, follow-ups (create/complete), escalation history
// (acknowledge/resolve), amendment history (clearly labeled immutable), and
// attachments. A "People involved" section is intentionally a placeholder --
// no incident_people/witness API exists anywhere in this codebase yet
// (IN-12 is unbuilt), so nothing is fabricated for it.
const incidentsPanel = (function () {
  const state = {
    items: [],
    page: 1,
    pageSize: 5,
    captureOpen: false,
    captureFields: emptyCaptureFields(),
    captureErrors: {},
    formError: null,
    detailId: null,
    detail: null,
    detailError: null,
    detailActionError: null,
    followups: [],
    followupsError: null,
    followupOpen: false,
    followupFields: { actionType: "", description: "", dueAt: "" },
    followupErrors: {},
    escalations: [],
    escalationsError: null,
    amendments: [],
    amendmentsError: null,
    amendOpen: false,
    amendFields: { reason: "", patch: {} },
    amendErrors: {}
  };

  function emptyCaptureFields() {
    return {
      reportType: "",
      severity: "",
      occurredAt: "",
      locationText: "",
      summary: "",
      immediateActions: "",
      requiresOshaReview: false
    };
  }

  function container() {
    return document.getElementById("incidents-workspace");
  }

  function refreshListItem(updated) {
    if (!updated || !updated.id) return;
    state.items = state.items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
  }

  async function load() {
    const host = container();
    if (!host || !currentFacility) return;
    setLoading(host, true);
    try {
      state.items = (await apiFetch(`/facilities/${currentFacility}/incidents`)) || [];
      state.page = 1;
      render();
    } catch (error) {
      renderInlineError(host, error);
    }
  }

  function reset() {
    state.items = [];
    state.captureOpen = false;
    state.captureFields = emptyCaptureFields();
    state.captureErrors = {};
    state.formError = null;
    state.page = 1;
    state.detailId = null;
    state.detail = null;
    state.followups = [];
    state.escalations = [];
    state.amendments = [];
    const host = container();
    if (host) host.textContent = "";
  }

  async function submitCapture() {
    const validation = validateIncidentCapture(state.captureFields);
    state.captureErrors = validation.errors;
    if (!validation.valid) {
      render();
      return;
    }
    try {
      const created = await apiFetch(`/facilities/${currentFacility}/incidents`, {
        method: "POST",
        body: buildIncidentCreatePayload(state.captureFields)
      });
      state.items.unshift(created);
      state.captureOpen = false;
      state.captureFields = emptyCaptureFields();
      state.captureErrors = {};
      state.formError = null;
      render();
      await openDetail(created.id);
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function openDetail(id) {
    state.detailId = id;
    state.detail = null;
    state.detailError = null;
    state.detailActionError = null;
    state.followups = [];
    state.followupsError = null;
    state.escalations = [];
    state.escalationsError = null;
    state.amendments = [];
    state.amendmentsError = null;
    render();
    try {
      state.detail = await apiFetch(`/incidents/${id}`);
    } catch (error) {
      state.detailError = error.message;
      render();
      return;
    }
    const [followups, amendments] = await Promise.all([
      apiFetch(`/incidents/${id}/followups`).catch((error) => {
        state.followupsError = error.message;
        return [];
      }),
      apiFetch(`/incidents/${id}/amendments`).catch((error) => {
        state.amendmentsError = error.message;
        return [];
      })
    ]);
    state.followups = followups || [];
    state.amendments = amendments || [];
    // No per-incident escalations route exists -- the facility-wide list is
    // filtered client-side to this incident's rows.
    try {
      const escalations = await apiFetch(`/facilities/${currentFacility}/incident-escalations`);
      state.escalations = (escalations || []).filter((row) => row.incident_id === id);
    } catch (error) {
      state.escalationsError = error.message;
    }
    render();
  }

  function closeDetail() {
    state.detailId = null;
    state.detail = null;
    render();
  }

  async function submitIncident() {
    try {
      const result = await apiFetch(`/incidents/${state.detailId}/submit`, { method: "POST" });
      state.detail = result;
      state.detailActionError = null;
      refreshListItem(result);
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function changeStatus(nextStatus, reason) {
    if (!nextStatus) return;
    try {
      const body = reason && reason.trim() ? { to: nextStatus, reason: reason.trim() } : { to: nextStatus };
      const result = await apiFetch(`/incidents/${state.detailId}/status`, { method: "POST", body });
      state.detail = result;
      state.detailActionError = null;
      refreshListItem(result);
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function escalate() {
    try {
      await apiFetch(`/incidents/${state.detailId}/escalate`, { method: "POST", body: {} });
      const escalations = await apiFetch(`/facilities/${currentFacility}/incident-escalations`);
      state.escalations = (escalations || []).filter((row) => row.incident_id === state.detailId);
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function actOnEscalation(escalationId, action) {
    try {
      const updated = await apiFetch(`/escalations/${escalationId}/${action}`, { method: "POST" });
      state.escalations = state.escalations.map((row) => (row.id === escalationId ? updated : row));
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function createFollowup() {
    const validation = validateFollowupInput(state.followupFields);
    state.followupErrors = validation.errors;
    if (!validation.valid) {
      render();
      return;
    }
    try {
      const created = await apiFetch(`/incidents/${state.detailId}/followups`, {
        method: "POST",
        body: buildFollowupPayload(state.followupFields)
      });
      state.followups.push(created);
      state.followupOpen = false;
      state.followupFields = { actionType: "", description: "", dueAt: "" };
      state.followupErrors = {};
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function completeFollowup(id) {
    try {
      const updated = await apiFetch(`/followups/${id}`, { method: "PATCH", body: { status: "completed" } });
      state.followups = state.followups.map((row) => (row.id === id ? updated : row));
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function submitAmendment() {
    const validation = validateAmendmentInput(state.amendFields);
    state.amendErrors = validation.errors;
    if (!validation.valid) {
      render();
      return;
    }
    try {
      const result = await apiFetch(`/incidents/${state.detailId}/amendments`, {
        method: "POST",
        body: buildAmendmentPayload(state.amendFields)
      });
      state.amendments.push(result.amendment);
      state.detail = result.incident || state.detail;
      state.amendOpen = false;
      state.amendFields = { reason: "", patch: {} };
      state.amendErrors = {};
      state.detailActionError = null;
      refreshListItem(state.detail);
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  function buildCaptureForm() {
    const f = state.captureFields;
    const errors = state.captureErrors;
    const wrap = el("div", { class: "inline-form incident-capture-form" });

    function fieldRow(labelText, input, errorKey, required) {
      const row = el("div", { class: "report-field" });
      row.append(el("label", {}, `${labelText}${required ? " *" : ""}`));
      row.append(input);
      if (errors[errorKey]) row.append(el("div", { class: "field-error rr-error" }, errors[errorKey]));
      return row;
    }

    const typeSelect = document.createElement("select");
    typeSelect.append(el("option", { value: "" }, "Select type"));
    for (const type of INCIDENT_REPORT_TYPES) {
      const opt = el("option", { value: type }, type.replace(/_/g, " "));
      if (f.reportType === type) opt.selected = true;
      typeSelect.append(opt);
    }
    typeSelect.addEventListener("change", () => {
      f.reportType = typeSelect.value;
      render();
    });

    const severitySelect = document.createElement("select");
    severitySelect.append(el("option", { value: "" }, "Select severity"));
    for (const severity of INCIDENT_SEVERITIES) {
      const opt = el("option", { value: severity }, severity);
      if (f.severity === severity) opt.selected = true;
      severitySelect.append(opt);
    }
    severitySelect.addEventListener("change", () => {
      f.severity = severitySelect.value;
      render();
    });

    const occurredInput = el("input", { type: "datetime-local" });
    occurredInput.addEventListener("input", () => {
      f.occurredAt = occurredInput.value ? new Date(occurredInput.value).toISOString() : "";
    });

    const locationInput = el("input", { type: "text", value: f.locationText });
    locationInput.addEventListener("input", () => (f.locationText = locationInput.value));

    const summaryInput = document.createElement("textarea");
    summaryInput.value = f.summary;
    summaryInput.addEventListener("input", () => (f.summary = summaryInput.value));

    const gated = severityRequiresGating(f.severity);
    const actionsInput = document.createElement("textarea");
    actionsInput.value = f.immediateActions;
    actionsInput.addEventListener("input", () => (f.immediateActions = actionsInput.value));

    const oshaCheckbox = document.createElement("input");
    oshaCheckbox.type = "checkbox";
    oshaCheckbox.checked = !!f.requiresOshaReview;
    oshaCheckbox.addEventListener("change", () => (f.requiresOshaReview = oshaCheckbox.checked));

    wrap.append(
      fieldRow("Incident type", typeSelect, "reportType", true),
      fieldRow("Severity", severitySelect, "severity", true),
      fieldRow("Occurred at", occurredInput, "occurredAt", true),
      fieldRow("Location", locationInput, "locationText", true),
      fieldRow("Summary", summaryInput, "summary", true),
      fieldRow(
        `Immediate actions${gated ? " (required for high/critical severity)" : ""}`,
        actionsInput,
        "immediateActions",
        gated
      ),
      el("label", { class: "report-field-option" }, [oshaCheckbox, " Requires OSHA review"])
    );

    const submitBtn = el("button", { type: "button", class: "primary" }, "Save draft incident");
    submitBtn.addEventListener("click", () => submitCapture());
    wrap.append(submitBtn);
    if (state.formError) wrap.append(el("p", { class: "rr-error" }, state.formError));
    return wrap;
  }

  function buildFollowupForm() {
    const wrap = el("div", { class: "inline-form" });
    const typeSelect = document.createElement("select");
    typeSelect.append(el("option", { value: "" }, "Action type"));
    for (const type of FOLLOWUP_ACTION_TYPES) {
      const opt = el("option", { value: type }, type.replace(/_/g, " "));
      if (state.followupFields.actionType === type) opt.selected = true;
      typeSelect.append(opt);
    }
    typeSelect.addEventListener("change", () => (state.followupFields.actionType = typeSelect.value));
    const descInput = document.createElement("textarea");
    descInput.placeholder = "Description";
    descInput.value = state.followupFields.description;
    descInput.addEventListener("input", () => (state.followupFields.description = descInput.value));
    const dueInput = el("input", { type: "date" });
    dueInput.addEventListener("input", () => {
      state.followupFields.dueAt = dueInput.value ? new Date(dueInput.value).toISOString() : "";
    });
    const errorEl = el("p", { class: "rr-error" }, Object.values(state.followupErrors).join(" "));
    const submitBtn = el("button", { type: "button", class: "primary" }, "Create follow-up");
    submitBtn.addEventListener("click", () => createFollowup());
    wrap.append(typeSelect, descInput, dueInput, submitBtn, errorEl);
    return wrap;
  }

  function buildAmendmentForm() {
    const wrap = el("div", { class: "inline-form" });
    const reasonInput = document.createElement("textarea");
    reasonInput.placeholder = "Reason for this amendment";
    reasonInput.value = state.amendFields.reason;
    reasonInput.addEventListener("input", () => (state.amendFields.reason = reasonInput.value));
    wrap.append(el("label", {}, ["Reason", reasonInput]));

    for (const fieldKey of AMENDABLE_INCIDENT_FIELDS) {
      const row = el("div", { class: "report-field-option" });
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const existing = state.amendFields.patch[fieldKey];
      checkbox.checked = existing !== undefined;

      let valueControl;
      if (fieldKey === "severity") {
        valueControl = document.createElement("select");
        valueControl.append(el("option", { value: "" }, "-"));
        for (const severity of INCIDENT_SEVERITIES) valueControl.append(el("option", { value: severity }, severity));
        if (existing !== undefined) valueControl.value = existing;
      } else if (fieldKey === "requires_osha_review") {
        valueControl = document.createElement("input");
        valueControl.type = "checkbox";
        if (existing !== undefined) valueControl.checked = !!existing;
      } else {
        valueControl = document.createElement("textarea");
        if (existing !== undefined) valueControl.value = existing;
      }

      const syncPatch = () => {
        if (!checkbox.checked) {
          delete state.amendFields.patch[fieldKey];
          return;
        }
        state.amendFields.patch[fieldKey] =
          fieldKey === "requires_osha_review" ? valueControl.checked : valueControl.value;
      };
      checkbox.addEventListener("change", syncPatch);
      valueControl.addEventListener("input", syncPatch);
      valueControl.addEventListener("change", syncPatch);

      row.append(checkbox, ` ${fieldKey.replace(/_/g, " ")} `, valueControl);
      wrap.append(row);
    }

    const errorText = [state.amendErrors.reason, state.amendErrors.patch].filter(Boolean).join(" ");
    if (errorText) wrap.append(el("p", { class: "rr-error" }, errorText));
    const submitBtn = el("button", { type: "button", class: "primary" }, "Submit amendment");
    submitBtn.addEventListener("click", () => submitAmendment());
    wrap.append(submitBtn);
    return wrap;
  }

  const INCIDENT_NEXT_STATUS_CHOICES = ["under_review", "escalated", "action_pending", "closed"];

  function renderDetail() {
    const panel = el("div", { class: "report-form-area incident-detail" });
    const header = el("div", { class: "report-form-header" });
    header.append(el("h3", {}, state.detail ? state.detail.incident_no : "Loading incident…"));
    const closeBtn = el("button", { type: "button" }, "Close");
    closeBtn.addEventListener("click", () => closeDetail());
    header.append(closeBtn);
    panel.append(header);

    if (state.detailError) {
      panel.append(el("p", { class: "rr-error" }, state.detailError));
      return panel;
    }
    if (!state.detail) {
      panel.append(el("p", {}, "Loading…"));
      return panel;
    }
    const d = state.detail;
    if (state.detailActionError) panel.append(el("p", { class: "rr-error" }, state.detailActionError));

    const meta = el("div", { class: "report-inbox-meta" });
    meta.append(el("p", {}, `Status: ${d.status} · Severity: ${d.severity} · Type: ${d.report_type}`));
    meta.append(el("p", { class: "item-subtitle" }, d.summary));
    if (d.immediate_actions) meta.append(el("p", { class: "item-subtitle" }, `Immediate actions: ${d.immediate_actions}`));
    panel.append(meta);

    const actionsRow = el("div", { class: "detail-actions" });
    if (d.status === "draft" && hasPerm("incidents.manage")) {
      const submitBtn = el("button", { type: "button", class: "primary" }, "Submit incident");
      submitBtn.addEventListener("click", () => submitIncident());
      actionsRow.append(submitBtn);
    }
    if (hasPerm("incidents.manage")) {
      const escalateBtn = el("button", { type: "button" }, "Escalate");
      escalateBtn.addEventListener("click", () => escalate());
      actionsRow.append(escalateBtn);
    }
    if (hasPerm("incidents.review") && d.status !== "draft" && d.status !== "closed") {
      const select = document.createElement("select");
      for (const status of INCIDENT_NEXT_STATUS_CHOICES) select.append(el("option", { value: status }, status));
      const reasonInput = el("input", { type: "text", placeholder: "Reason (optional)" });
      const changeBtn = el("button", { type: "button" }, "Change status");
      changeBtn.addEventListener("click", () => changeStatus(select.value, reasonInput.value));
      actionsRow.append(select, reasonInput, changeBtn);
    }
    if (actionsRow.childNodes.length > 0) panel.append(actionsRow);

    panel.append(el("h4", {}, "People involved"));
    panel.append(el("p", { class: "item-subtitle" }, "Person/witness tracking isn't available in this release yet."));

    panel.append(el("h4", {}, "Follow-up actions"));
    if (state.followupsError) panel.append(el("p", { class: "rr-error" }, state.followupsError));
    if (state.followups.length === 0) panel.append(el("p", { class: "item-subtitle" }, "No follow-up actions yet."));
    for (const followup of state.followups) {
      const row = el("div", { class: "module-item" });
      row.append(el("div", { class: "item-title" }, `${followup.action_type} · ${followup.status}`));
      row.append(el("div", { class: "item-subtitle" }, followup.description));
      if (followup.due_at) {
        row.append(el("div", { class: "item-subtitle" }, `Due ${new Date(followup.due_at).toLocaleDateString()}`));
      }
      if (followup.status !== "completed" && followup.status !== "waived" && hasPerm("incidents.manage")) {
        const completeBtn = el("button", { type: "button" }, "Mark complete");
        completeBtn.addEventListener("click", () => completeFollowup(followup.id));
        row.append(completeBtn);
      }
      panel.append(row);
    }
    if (hasPerm("incidents.tasks.create")) {
      const toggleBtn = el("button", { type: "button" }, state.followupOpen ? "Cancel" : "Add follow-up");
      toggleBtn.addEventListener("click", () => {
        state.followupOpen = !state.followupOpen;
        render();
      });
      panel.append(toggleBtn);
      if (state.followupOpen) panel.append(buildFollowupForm());
    }

    panel.append(el("h4", {}, "Escalation history"));
    if (state.escalationsError) panel.append(el("p", { class: "rr-error" }, state.escalationsError));
    if (state.escalations.length === 0) panel.append(el("p", { class: "item-subtitle" }, "No escalations."));
    for (const escalation of state.escalations) {
      const row = el("div", { class: "module-item" });
      row.append(
        el("div", { class: "item-title" }, `Level ${escalation.escalation_level} · ${escalation.target_role} · ${escalation.status}`)
      );
      row.append(el("div", { class: "item-subtitle" }, `Due ${new Date(escalation.due_at).toLocaleString()}`));
      if (escalation.overdue) row.append(badge("Overdue", "danger"));
      const action = nextEscalationAction(escalation.status);
      if (action && hasPerm("incidents.manage")) {
        const actionBtn = el("button", { type: "button" }, action === "acknowledge" ? "Acknowledge" : "Resolve");
        actionBtn.addEventListener("click", () => actOnEscalation(escalation.id, action));
        row.append(actionBtn);
      }
      panel.append(row);
    }

    panel.append(el("h4", {}, "Amendment history (immutable — every amendment is permanently retained)"));
    if (state.amendmentsError) panel.append(el("p", { class: "rr-error" }, state.amendmentsError));
    if (state.amendments.length === 0) panel.append(el("p", { class: "item-subtitle" }, "No amendments."));
    for (const amendment of state.amendments) {
      const row = el("div", { class: "module-item" });
      row.append(el("div", { class: "item-title" }, `Amended ${new Date(amendment.amended_at).toLocaleString()}`));
      row.append(el("div", { class: "item-subtitle" }, amendment.amendment_reason));
      const before = amendment.before_snapshot || {};
      const after = amendment.after_snapshot || {};
      const changed = AMENDABLE_INCIDENT_FIELDS.filter((key) => key in after && before[key] !== after[key]);
      for (const key of changed) {
        row.append(el("div", { class: "item-subtitle" }, `${key}: ${before[key]} → ${after[key]}`));
      }
      panel.append(row);
    }
    if ((hasPerm("incidents.manage") || hasPerm("incidents.review")) && d.status !== "draft") {
      const toggleBtn = el("button", { type: "button" }, state.amendOpen ? "Cancel" : "Amend incident");
      toggleBtn.addEventListener("click", () => {
        state.amendOpen = !state.amendOpen;
        render();
      });
      panel.append(toggleBtn);
      if (state.amendOpen) panel.append(buildAmendmentForm());
    }

    panel.append(el("h4", {}, "Attachments"));
    panel.append(buildAttachmentsToggle("incidents", d.id, hasPerm("incidents.manage")));
    wireAttachmentToggles(panel);

    return panel;
  }

  function render() {
    const host = container();
    if (!host) return;
    host.textContent = "";

    if (hasPerm("incidents.manage")) {
      const toggleBtn = el(
        "button",
        { type: "button", class: "primary" },
        state.captureOpen ? "Cancel new incident" : "Report new incident"
      );
      toggleBtn.addEventListener("click", () => {
        state.captureOpen = !state.captureOpen;
        render();
      });
      host.append(toggleBtn);
      if (state.captureOpen) host.append(buildCaptureForm());
    }

    const listWrap = el("div", { class: "module-list" });
    if (state.items.length === 0) {
      listWrap.append(el("p", {}, "No incidents reported."));
    } else {
      const { pageItems, ...pageInfo } = paginate(state.items, state.page, state.pageSize);
      for (const incident of pageItems) {
        const card = el("div", { class: "incident-card" });
        card.append(el("strong", {}, `${incident.incident_no} · ${incident.report_type} · ${incident.severity}`));
        card.append(el("div", { class: "item-subtitle" }, incident.location_text));
        card.append(el("div", { class: "item-subtitle" }, `Status: ${incident.status}`));
        if (incident.requires_osha_review) card.append(el("div", { class: "osha-warning" }, "OSHA review required"));
        const viewBtn = el("button", { type: "button" }, "View");
        viewBtn.addEventListener("click", () => openDetail(incident.id));
        card.append(viewBtn);
        listWrap.append(card);
      }
      const bar = buildPaginationBar(pageInfo, (p) => {
        state.page = p;
        render();
      });
      if (bar) listWrap.append(bar);
    }
    host.append(listWrap);

    if (state.detailId) host.append(renderDetail());
  }

  return { load, reset };
})();

// --- Work orders module (WO-10) -----------------------------------------------
// Filter chips (open/mine/overdue) + priority, create form, server-paginated
// list (WO-05's ?limit=/?offset=), and a detail view with the comment thread
// and status/assign actions.
const workOrdersPanel = (function () {
  const state = {
    items: [],
    page: 1,
    pageSize: 10,
    chip: "all",
    priority: "",
    employees: [],
    myEmployeeId: null,
    createOpen: false,
    createFields: emptyCreateFields(),
    createErrors: {},
    formError: null,
    detailId: null,
    detail: null,
    detailError: null,
    detailActionError: null,
    updates: [],
    updatesError: null,
    commentText: ""
  };

  function emptyCreateFields() {
    return { title: "", description: "", priority: "", assetId: "", assignedToEmployeeId: "", dueAt: "" };
  }

  function container() {
    return document.getElementById("work-orders-workspace");
  }

  function refreshListItem(updated) {
    if (!updated || !updated.id) return;
    state.items = state.items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
  }

  async function load() {
    const host = container();
    if (!host || !currentFacility) return;
    setLoading(host, true);
    // GET /facilities/:id/employees is registered by the scheduling module
    // (gated on schedule.read) but serves as the facility's employee
    // directory app-wide -- reused here for the assignee picker and to
    // resolve the caller's own employee id for the "Mine" filter chip.
    const employees = await apiFetch(`/facilities/${currentFacility}/employees`).catch(() => []);
    state.employees = employees || [];
    state.myEmployeeId = (state.employees.find((e) => e.user_id === (currentUser && currentUser.id)) || {}).id || null;
    await loadList();
  }

  async function loadList() {
    const host = container();
    if (!host || !currentFacility) return;
    try {
      const params = buildWorkOrderQuery({
        chip: state.chip,
        priority: state.priority,
        myEmployeeId: state.myEmployeeId,
        page: state.page,
        pageSize: state.pageSize
      });
      state.items = (await apiFetch(`/facilities/${currentFacility}/work-orders?${params.toString()}`)) || [];
      state.formError = null;
      render();
    } catch (error) {
      state.items = [];
      state.formError = error.message;
      render();
    }
  }

  function reset() {
    state.items = [];
    state.createOpen = false;
    state.createFields = emptyCreateFields();
    state.createErrors = {};
    state.formError = null;
    state.chip = "all";
    state.priority = "";
    state.page = 1;
    state.detailId = null;
    state.detail = null;
    const host = container();
    if (host) host.textContent = "";
  }

  function setChip(chip) {
    state.chip = chip;
    state.page = 1;
    loadList();
  }

  function setPriority(priority) {
    state.priority = priority;
    state.page = 1;
    loadList();
  }

  function changePage(page) {
    state.page = Math.max(1, page);
    loadList();
  }

  async function createWorkOrder() {
    const validation = validateWorkOrderCreate(state.createFields);
    state.createErrors = validation.errors;
    if (!validation.valid) {
      render();
      return;
    }
    try {
      const created = await apiFetch(`/facilities/${currentFacility}/work-orders`, {
        method: "POST",
        body: buildWorkOrderCreatePayload(state.createFields)
      });
      state.createOpen = false;
      state.createFields = emptyCreateFields();
      state.createErrors = {};
      state.formError = null;
      await loadList();
      await openDetail(created.id);
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function openDetail(id) {
    state.detailId = id;
    state.detail = null;
    state.detailError = null;
    state.detailActionError = null;
    state.updates = [];
    state.updatesError = null;
    render();
    try {
      state.detail = await apiFetch(`/work-orders/${id}`);
    } catch (error) {
      state.detailError = error.message;
      render();
      return;
    }
    try {
      state.updates = (await apiFetch(`/work-orders/${id}/updates`)) || [];
    } catch (error) {
      state.updatesError = error.message;
    }
    render();
  }

  function closeDetail() {
    state.detailId = null;
    state.detail = null;
    render();
  }

  async function postComment() {
    const text = (state.commentText || "").trim();
    if (!text) return;
    try {
      const created = await apiFetch(`/work-orders/${state.detailId}/updates`, { method: "POST", body: { body: text } });
      state.updates.push(created);
      state.commentText = "";
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function changeStatus(nextStatus) {
    try {
      const updated = await apiFetch(`/work-orders/${state.detailId}`, { method: "PATCH", body: { status: nextStatus } });
      state.detail = updated;
      refreshListItem(updated);
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function assign(employeeId) {
    try {
      const updated = await apiFetch(`/work-orders/${state.detailId}`, {
        method: "PATCH",
        body: { assigned_to_employee_id: employeeId || null }
      });
      state.detail = updated;
      refreshListItem(updated);
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  function buildCreateForm() {
    const f = state.createFields;
    const wrap = el("div", { class: "inline-form" });
    const titleInput = el("input", { type: "text", value: f.title, placeholder: "Title" });
    titleInput.addEventListener("input", () => (f.title = titleInput.value));
    const descInput = document.createElement("textarea");
    descInput.placeholder = "Description";
    descInput.value = f.description;
    descInput.addEventListener("input", () => (f.description = descInput.value));
    const prioritySelect = document.createElement("select");
    prioritySelect.append(el("option", { value: "" }, "Select priority"));
    for (const priority of WORK_ORDER_PRIORITIES) prioritySelect.append(el("option", { value: priority }, priority));
    prioritySelect.value = f.priority;
    prioritySelect.addEventListener("change", () => (f.priority = prioritySelect.value));
    const assetInput = el("input", { type: "text", placeholder: "Asset ID (optional)" });
    assetInput.addEventListener("input", () => (f.assetId = assetInput.value));
    const assigneeSelect = document.createElement("select");
    assigneeSelect.append(el("option", { value: "" }, "Unassigned"));
    for (const employee of state.employees) {
      assigneeSelect.append(el("option", { value: employee.id }, `${employee.first_name} ${employee.last_name}`));
    }
    assigneeSelect.addEventListener("change", () => (f.assignedToEmployeeId = assigneeSelect.value));
    const dueInput = el("input", { type: "date" });
    dueInput.addEventListener("input", () => {
      f.dueAt = dueInput.value ? new Date(dueInput.value).toISOString() : "";
    });
    const submitBtn = el("button", { type: "button", class: "primary" }, "Create work order");
    submitBtn.addEventListener("click", () => createWorkOrder());
    const errorEl = el("p", { class: "rr-error" }, Object.values(state.createErrors).join(" "));
    wrap.append(
      el("label", {}, ["Title", titleInput]),
      el("label", {}, ["Description", descInput]),
      el("label", {}, ["Priority", prioritySelect]),
      el("label", {}, ["Asset", assetInput]),
      el("label", {}, ["Assignee", assigneeSelect]),
      el("label", {}, ["Due date", dueInput]),
      submitBtn,
      errorEl
    );
    return wrap;
  }

  function buildCard(wo) {
    const card = el("div", { class: "work-order-card" });
    card.append(el("strong", {}, `${wo.priority} · ${wo.title}`));
    card.append(el("div", { class: "item-subtitle" }, wo.description));
    card.append(el("div", { class: "item-subtitle" }, `Status: ${wo.status}`));
    if (wo.due_at) card.append(el("div", { class: "item-subtitle" }, `Due ${new Date(wo.due_at).toLocaleDateString()}`));
    const viewBtn = el("button", { type: "button" }, "View");
    viewBtn.addEventListener("click", () => openDetail(wo.id));
    card.append(viewBtn);
    card.append(buildAttachmentsToggle("work-orders", wo.id, hasPerm("work_orders.manage")));
    return card;
  }

  function renderDetail() {
    const panel = el("div", { class: "report-form-area work-order-detail" });
    const header = el("div", { class: "report-form-header" });
    header.append(el("h3", {}, state.detail ? state.detail.title : "Loading work order…"));
    const closeBtn = el("button", { type: "button" }, "Close");
    closeBtn.addEventListener("click", () => closeDetail());
    header.append(closeBtn);
    panel.append(header);

    if (state.detailError) {
      panel.append(el("p", { class: "rr-error" }, state.detailError));
      return panel;
    }
    if (!state.detail) {
      panel.append(el("p", {}, "Loading…"));
      return panel;
    }
    const wo = state.detail;
    if (state.detailActionError) panel.append(el("p", { class: "rr-error" }, state.detailActionError));

    panel.append(el("p", { class: "item-subtitle" }, wo.description));
    panel.append(
      el(
        "p",
        {},
        `Priority: ${wo.priority} · Status: ${wo.status}${wo.due_at ? " · Due " + new Date(wo.due_at).toLocaleDateString() : ""}`
      )
    );

    if (hasPerm("work_orders.manage")) {
      const actionsRow = el("div", { class: "detail-actions" });
      const statusSelect = document.createElement("select");
      for (const status of WORK_ORDER_STATUSES) statusSelect.append(el("option", { value: status }, status));
      statusSelect.value = wo.status;
      const statusBtn = el("button", { type: "button" }, "Update status");
      statusBtn.addEventListener("click", () => changeStatus(statusSelect.value));
      actionsRow.append(statusSelect, statusBtn);

      if (state.employees.length > 0) {
        const assignSelect = document.createElement("select");
        assignSelect.append(el("option", { value: "" }, "Unassigned"));
        for (const employee of state.employees) {
          const opt = el("option", { value: employee.id }, `${employee.first_name} ${employee.last_name}`);
          if (employee.id === wo.assigned_to_employee_id) opt.selected = true;
          assignSelect.append(opt);
        }
        const assignBtn = el("button", { type: "button" }, "Assign");
        assignBtn.addEventListener("click", () => assign(assignSelect.value));
        actionsRow.append(assignSelect, assignBtn);
      }
      panel.append(actionsRow);
    }

    panel.append(el("h4", {}, "Comments"));
    if (state.updatesError) panel.append(el("p", { class: "rr-error" }, state.updatesError));
    if (state.updates.length === 0) panel.append(el("p", { class: "item-subtitle" }, "No updates yet."));
    for (const update of state.updates) {
      const row = el("div", { class: "module-item" });
      const label = update.update_type === "comment" ? "Comment" : update.update_type.replace(/_/g, " ");
      row.append(el("div", { class: "item-title" }, label));
      if (update.body) row.append(el("div", {}, update.body));
      if (update.previous_value !== null || update.new_value !== null) {
        row.append(el("div", { class: "item-subtitle" }, `${update.previous_value ?? "—"} → ${update.new_value ?? "—"}`));
      }
      row.append(el("div", { class: "item-subtitle" }, new Date(update.created_at).toLocaleString()));
      panel.append(row);
    }
    if (hasPerm("work_orders.manage")) {
      const commentBox = document.createElement("textarea");
      commentBox.placeholder = "Add a comment";
      commentBox.value = state.commentText;
      commentBox.addEventListener("input", () => (state.commentText = commentBox.value));
      const postBtn = el("button", { type: "button", class: "primary" }, "Post comment");
      postBtn.addEventListener("click", () => postComment());
      panel.append(commentBox, postBtn);
    }

    panel.append(el("h4", {}, "Attachments"));
    panel.append(buildAttachmentsToggle("work-orders", wo.id, hasPerm("work_orders.manage")));
    wireAttachmentToggles(panel);

    return panel;
  }

  function render() {
    const host = container();
    if (!host) return;
    host.textContent = "";

    const chipsRow = el("div", { class: "filter-chips" });
    const chipLabels = { all: "All", open: "Open", overdue: "Overdue" };
    for (const chip of ["all", "open", "overdue"]) {
      const btn = el("button", { type: "button", class: state.chip === chip ? "chip active" : "chip" }, chipLabels[chip]);
      btn.addEventListener("click", () => setChip(chip));
      chipsRow.append(btn);
    }
    if (state.myEmployeeId) {
      const mineBtn = el("button", { type: "button", class: state.chip === "mine" ? "chip active" : "chip" }, "Mine");
      mineBtn.addEventListener("click", () => setChip("mine"));
      chipsRow.append(mineBtn);
    }
    const prioritySelect = document.createElement("select");
    prioritySelect.append(el("option", { value: "" }, "All priorities"));
    for (const priority of WORK_ORDER_PRIORITIES) {
      const opt = el("option", { value: priority }, priority);
      if (state.priority === priority) opt.selected = true;
      prioritySelect.append(opt);
    }
    prioritySelect.addEventListener("change", () => setPriority(prioritySelect.value));
    chipsRow.append(prioritySelect);
    host.append(chipsRow);

    if (hasPerm("work_orders.manage")) {
      const toggleBtn = el(
        "button",
        { type: "button", class: "primary" },
        state.createOpen ? "Cancel new work order" : "New work order"
      );
      toggleBtn.addEventListener("click", () => {
        state.createOpen = !state.createOpen;
        render();
      });
      host.append(toggleBtn);
      if (state.createOpen) host.append(buildCreateForm());
    }

    if (state.formError) host.append(el("p", { class: "rr-error" }, state.formError));

    const listWrap = el("div", { class: "module-list" });
    if (state.items.length === 0) {
      listWrap.append(el("p", {}, "No work orders match these filters."));
    } else {
      for (const wo of state.items) listWrap.append(buildCard(wo));
      wireAttachmentToggles(listWrap);
    }
    host.append(listWrap);

    const paginationInfo = { page: state.page, hasPrev: state.page > 1, hasNext: state.items.length === state.pageSize };
    const bar = buildPaginationBar(paginationInfo, (p) => changePage(p));
    if (bar) host.append(bar);

    if (state.detailId) host.append(renderDetail());
  }

  return { load, reset };
})();

// --- Communications module (CM-08/CM-09) --------------------------------------
// Compose form (channel/audience/priority/required-ack) posting through the
// draft-then-publish flow (CM-03), a paginated message list that auto-marks
// delivered/read receipts as it renders, and a per-viewer ack-state badge.
//
// Known API gap, worked around rather than papered over: there is no GET for
// message_acknowledgements, so "has THIS viewer already acknowledged" can
// only be known for an acknowledgement made during this session
// (ackedMessageIds) -- a message acknowledged in an earlier session still
// renders as pending/overdue rather than a guessed "complete".
const commsPanel = (function () {
  const state = {
    channels: [],
    messages: [],
    page: 1,
    pageSize: 5,
    composeOpen: false,
    composeFields: emptyComposeFields(),
    composeErrors: {},
    audienceRows: [{ audienceType: "", audienceRefId: "" }],
    audienceError: null,
    ackedMessageIds: new Set(),
    receiptSentIds: new Set(),
    formError: null
  };

  function emptyComposeFields() {
    return { channelId: "", subject: "", bodyText: "", priority: "normal", isRequiredAck: false, ackDueAt: "" };
  }

  function container() {
    return document.getElementById("comms-workspace");
  }

  async function load() {
    const host = container();
    if (!host || !currentFacility) return;
    setLoading(host, true);
    try {
      state.channels = (await apiFetch(`/facilities/${currentFacility}/channels`).catch(() => [])) || [];
      await loadMessagesList();
    } catch (error) {
      renderInlineError(host, error);
    }
  }

  async function loadMessagesList() {
    const host = container();
    if (!host || !currentFacility) return;
    try {
      state.messages = (await apiFetch(`/facilities/${currentFacility}/messages`)) || [];
      state.page = 1;
      state.formError = null;
      render();
    } catch (error) {
      renderInlineError(host, error);
    }
  }

  function reset() {
    state.composeOpen = false;
    state.composeFields = emptyComposeFields();
    state.composeErrors = {};
    state.audienceRows = [{ audienceType: "", audienceRefId: "" }];
    state.audienceError = null;
    state.formError = null;
    state.page = 1;
    state.ackedMessageIds = new Set();
    state.receiptSentIds = new Set();
    const host = container();
    if (host) host.textContent = "";
  }

  // Marks delivered/read for every message about to render, once per message
  // id per panel load (receiptSentIds), fire-and-forget so it never blocks
  // rendering; a 403 (e.g. no employee record for this facility) is silently
  // swallowed rather than surfaced, since it's a background side effect, not
  // a user-initiated action.
  function markReceiptsForVisibleMessages(messages) {
    const now = new Date().toISOString();
    for (const message of messages) {
      if (state.receiptSentIds.has(message.id)) continue;
      state.receiptSentIds.add(message.id);
      apiFetch(`/messages/${message.id}/receipt`, { method: "POST", body: { deliveredAt: now, readAt: now } }).catch(() => {});
    }
  }

  async function acknowledge(id) {
    try {
      await apiFetch(`/messages/${id}/acknowledge`, { method: "POST" });
      state.ackedMessageIds.add(id);
      state.formError = null;
      render();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function composeAndPublish() {
    const validation = validateComposeInput(state.composeFields);
    state.composeErrors = validation.errors;
    const audienceValidation = validateAudienceRows(state.audienceRows);
    state.audienceError = audienceValidation.valid ? null : audienceValidation.error;
    if (!validation.valid || !audienceValidation.valid) {
      render();
      return;
    }
    try {
      const draft = await apiFetch(`/facilities/${currentFacility}/messages`, {
        method: "POST",
        body: buildComposePayload(state.composeFields)
      });
      const audiencePayload = buildAudiencePayload(state.audienceRows);
      if (audiencePayload.length > 0) {
        await apiFetch(`/messages/${draft.id}/audiences`, { method: "POST", body: audiencePayload });
      }
      await apiFetch(`/facilities/${currentFacility}/messages/${draft.id}/publish`, { method: "POST" });
      state.composeOpen = false;
      state.composeFields = emptyComposeFields();
      state.composeErrors = {};
      state.audienceRows = [{ audienceType: "", audienceRefId: "" }];
      state.audienceError = null;
      state.formError = null;
      await loadMessagesList();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  function buildComposeForm() {
    const f = state.composeFields;
    const errors = state.composeErrors;
    const wrap = el("div", { class: "inline-form compose-form" });

    const channelSelect = document.createElement("select");
    channelSelect.append(el("option", { value: "" }, "Select channel"));
    for (const channel of state.channels) {
      const opt = el("option", { value: channel.id }, channel.name);
      if (f.channelId === channel.id) opt.selected = true;
      channelSelect.append(opt);
    }
    channelSelect.addEventListener("change", () => (f.channelId = channelSelect.value));

    const subjectInput = el("input", { type: "text", value: f.subject, placeholder: "Subject" });
    subjectInput.addEventListener("input", () => (f.subject = subjectInput.value));

    const bodyInput = document.createElement("textarea");
    bodyInput.placeholder = "Message";
    bodyInput.value = f.bodyText;
    bodyInput.addEventListener("input", () => (f.bodyText = bodyInput.value));

    const prioritySelect = document.createElement("select");
    for (const priority of MESSAGE_PRIORITIES) {
      const opt = el("option", { value: priority }, priority);
      if (f.priority === priority) opt.selected = true;
      prioritySelect.append(opt);
    }
    prioritySelect.addEventListener("change", () => (f.priority = prioritySelect.value));

    const ackCheckbox = document.createElement("input");
    ackCheckbox.type = "checkbox";
    ackCheckbox.checked = !!f.isRequiredAck;
    ackCheckbox.addEventListener("change", () => {
      f.isRequiredAck = ackCheckbox.checked;
      render();
    });

    wrap.append(
      el("label", {}, ["Channel", channelSelect]),
      el("label", {}, ["Subject", subjectInput]),
      el("label", {}, ["Body", bodyInput]),
      el("label", {}, ["Priority", prioritySelect]),
      el("label", { class: "report-field-option" }, [ackCheckbox, " Require acknowledgement"])
    );

    if (f.isRequiredAck) {
      const ackDueInput = el("input", { type: "date" });
      ackDueInput.addEventListener("input", () => {
        f.ackDueAt = ackDueInput.value ? new Date(ackDueInput.value).toISOString() : "";
      });
      wrap.append(el("label", {}, ["Acknowledgement due", ackDueInput]));
    }

    if (Object.keys(errors).length > 0) {
      wrap.append(el("p", { class: "rr-error" }, Object.values(errors).join(" ")));
    }

    wrap.append(el("h4", {}, "Audience"));
    const audienceWrap = el("div", { class: "audience-picker" });
    state.audienceRows.forEach((row, index) => {
      const rowEl = el("div", { class: "audience-row" });
      const typeSelect = document.createElement("select");
      typeSelect.append(el("option", { value: "" }, "Type"));
      for (const type of AUDIENCE_TYPES) {
        const opt = el("option", { value: type }, type);
        if (row.audienceType === type) opt.selected = true;
        typeSelect.append(opt);
      }
      typeSelect.addEventListener("change", () => (row.audienceType = typeSelect.value));
      const refInput = el("input", { type: "text", value: row.audienceRefId, placeholder: "Target id" });
      refInput.addEventListener("input", () => (row.audienceRefId = refInput.value));
      const removeBtn = el("button", { type: "button" }, "Remove");
      removeBtn.addEventListener("click", () => {
        state.audienceRows.splice(index, 1);
        if (state.audienceRows.length === 0) state.audienceRows.push({ audienceType: "", audienceRefId: "" });
        render();
      });
      rowEl.append(typeSelect, refInput, removeBtn);
      audienceWrap.append(rowEl);
    });
    wrap.append(audienceWrap);
    const addRowBtn = el("button", { type: "button" }, "Add audience");
    addRowBtn.addEventListener("click", () => {
      state.audienceRows.push({ audienceType: "", audienceRefId: "" });
      render();
    });
    wrap.append(addRowBtn);
    if (state.audienceError) wrap.append(el("p", { class: "rr-error" }, state.audienceError));

    const publishBtn = el("button", { type: "button", class: "primary" }, "Publish message");
    publishBtn.addEventListener("click", () => composeAndPublish());
    wrap.append(publishBtn);
    return wrap;
  }

  function buildMessageCard(message) {
    const card = el("div", { class: "message-card" });
    card.append(el("strong", {}, `${message.priority} · ${message.subject}`));
    card.append(el("div", { class: "item-subtitle" }, (message.body_text || "").slice(0, 140)));

    const ackState = deriveAckState({
      isRequiredAck: message.is_required_ack,
      ackDueAt: message.ack_due_at,
      ackedByMe: state.ackedMessageIds.has(message.id)
    });
    const badgeVariant = { pending: "info", overdue: "danger", complete: "success" }[ackState];
    if (badgeVariant) card.append(badge(ackState.replace(/_/g, " "), badgeVariant));
    if (message.is_required_ack && ackState !== "complete") {
      const ackBtn = el("button", { type: "button", class: "primary" }, "Acknowledge");
      ackBtn.addEventListener("click", () => acknowledge(message.id));
      card.append(ackBtn);
    }
    return card;
  }

  function render() {
    const host = container();
    if (!host) return;
    host.textContent = "";

    if (hasPerm("communications.publish")) {
      const toggleBtn = el(
        "button",
        { type: "button", class: "primary" },
        state.composeOpen ? "Cancel compose" : "Compose message"
      );
      toggleBtn.addEventListener("click", () => {
        state.composeOpen = !state.composeOpen;
        render();
      });
      host.append(toggleBtn);
      if (state.composeOpen) host.append(buildComposeForm());
    }

    if (state.formError) host.append(el("p", { class: "rr-error" }, state.formError));

    const listWrap = el("div", { class: "module-list" });
    if (state.messages.length === 0) {
      listWrap.append(el("p", {}, "No messages."));
    } else {
      const { pageItems, ...pageInfo } = paginate(state.messages, state.page, state.pageSize);
      markReceiptsForVisibleMessages(pageItems);
      for (const message of pageItems) listWrap.append(buildMessageCard(message));
      const bar = buildPaginationBar(pageInfo, (p) => {
        state.page = p;
        render();
      });
      if (bar) listWrap.append(bar);
    }
    host.append(listWrap);
  }

  return { load, reset };
})();

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

// Sign out handler. Revokes the refresh token upstream first so the session
// cannot be resumed elsewhere, then clears local storage and redirects. The
// local clear runs even if revocation fails, so signing out always works.
function setupSignOut() {
  const signOutBtn = document.getElementById("sign-out-btn");
  if (!signOutBtn) return;
  signOutBtn.addEventListener("click", async () => {
    signOutBtn.disabled = true;
    const token = getToken();
    if (token) {
      try {
        await fetch(`${API_BASE}/auth/sign-out`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
        });
      } catch {
        // Ignore: the local clear below is what signs this browser out.
      }
    }
    clearAuthAndRedirect();
  });
}

// Start app on load
document.addEventListener("DOMContentLoaded", () => {
  setupSignOut();
  initialize();
});
