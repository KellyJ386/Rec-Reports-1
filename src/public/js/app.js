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
  AMENDABLE_INCIDENT_FIELDS,
  INCIDENT_PERSON_ROLES,
  validatePersonInput,
  buildPersonPayload,
  validateStatementInput,
  buildStatementPayload
} from "./incident-form.mjs";
import { paginate } from "./list-pagination.mjs";
import {
  WORK_ORDER_STATUSES,
  WORK_ORDER_PRIORITIES,
  buildWorkOrderQuery,
  validateWorkOrderCreate,
  buildWorkOrderCreatePayload
} from "./work-order-filters.mjs";
import {
  weekBoundsFor,
  bucketShiftsByDay,
  deriveShiftBadges,
  validateShiftCreate,
  buildShiftCreatePayload,
  indexAssignmentsByShift
} from "./schedule-board.mjs";
import {
  MESSAGE_PRIORITIES,
  AUDIENCE_TYPES,
  validateComposeInput,
  buildComposePayload,
  validateAudienceRows,
  buildAudiencePayload,
  deriveAckState,
  ackedMessageIdsFromRows,
  shouldFetchCompliance,
  formatComplianceSummary
} from "./comms-compose.mjs";
import { resolveInitialFacility } from "./facility-context.mjs";
import { buildQuickActions, buildTiles, computeTodayShiftsForMe, HOME_DASHBOARD_PERMISSION_CODES } from "./home-dashboard.mjs";
import { sanitizeQuery, groupResults, debounce } from "./search.mjs";

const TOKEN_KEY = "rr_admin_token";
// S-11: the refresh token itself lives only in the HttpOnly `rr_refresh`
// cookie the server sets -- this key is read (once, then deleted) only as a
// one-release migration path for a session that signed in before that
// change and still has a token sitting in localStorage from the old flow.
const LEGACY_REFRESH_TOKEN_KEY = "rr_refresh_token";
const FACILITY_KEY = "rr_facility_id";
const API_BASE = "/api/v1";

// State
let currentUser = null;
let currentFacility = null;
let facilities = [];
let platformAdmin = false;
let reportTemplatesById = new Map();
// Full published-template rows for the active facility (as opposed to
// reportTemplatesById's id->name lookup, used by the inbox) -- kept so the
// home dashboard's "Submit report" quick action can jump straight into
// startNewReport when there is exactly one template to choose from, without
// a second fetch.
let publishedReportTemplates = [];

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

// Helper: Get/set the last-selected facility id, mirroring the
// rr_admin_context pattern in src/public/admin/js/state.js -- persisted so a
// reload (or a return visit) keeps the operator on the facility they were
// last working in instead of always resetting to the first one.
function getStoredFacilityId() {
  try {
    return localStorage.getItem(FACILITY_KEY) || "";
  } catch {
    return "";
  }
}

function setStoredFacilityId(facilityId) {
  try {
    if (facilityId) localStorage.setItem(FACILITY_KEY, facilityId);
    else localStorage.removeItem(FACILITY_KEY);
  } catch {
    // Storage may be unavailable; the switcher still works for this session.
  }
}

// Helper: Clear the stored access token and redirect to signin. The refresh
// token is a cookie the server owns (S-11) -- clearing it is the sign-out
// route's job (see setupSignOut), not something this client-side helper can
// or should do on its own.
function clearAuthAndRedirect() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be unavailable
  }
  window.location.assign("/signin/");
}

// One-release compat (S-11): a session that signed in before the refresh
// token moved into the `rr_refresh` cookie may still have one sitting in
// localStorage. On load, exchange it through /auth/refresh's body fallback
// exactly once so the browser picks up the cookie, then delete the key --
// every later refresh goes through the cookie like any other session. A
// missing/empty key is the common case and a silent no-op.
async function migrateLegacyRefreshToken() {
  let legacyToken = "";
  try {
    legacyToken = localStorage.getItem(LEGACY_REFRESH_TOKEN_KEY) || "";
  } catch {
    return;
  }
  if (!legacyToken) return;
  try {
    localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  } catch {
    // Nothing more to do if storage is unavailable.
  }
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: legacyToken })
    });
    if (!response.ok) return;
    const session = await response.json();
    if (session?.access_token) localStorage.setItem(TOKEN_KEY, session.access_token);
  } catch {
    // Network failure: the legacy key is already gone -- the user simply
    // re-authenticates like anyone else whose session has fully expired.
  }
}

// Helper: Exchange the rr_refresh cookie for a new session. Single-flight,
// because several calls can 401 at once when the access token expires and
// the refresh cookie is single-use. Resolves true when a fresh access token
// was stored.
//
// Two-tab race: this only serializes refreshes *within one tab*. Two tabs
// refreshing at nearly the same moment each send the same (single-use, at
// the time they read it) rr_refresh cookie; GoTrue's refresh-token reuse
// detection/reuse-interval is what keeps the loser from being treated as
// token theft, not anything in this file -- see S-11 in the implementation
// plan for the risk note.
let refreshInFlight = null;

async function exchangeRefreshToken() {
  let response;
  try {
    response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: "{}"
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

      // Restore the last-selected facility if it's still in this user's
      // list, else fall back to the first one (resolveInitialFacility
      // returns null only when `facilities` itself is empty).
      currentFacility = resolveInitialFacility(getStoredFacilityId(), facilities);
      if (currentFacility) {
        facilitySelect.value = currentFacility;
        setStoredFacilityId(currentFacility);
        await loadAllModules();
      }

      // Listen for facility changes
      facilitySelect.addEventListener("change", async (e) => {
        currentFacility = e.target.value;
        setStoredFacilityId(currentFacility);
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

  // P-3: quick actions render synchronously (permission-driven, no fetch of
  // their own) so they're on screen immediately -- above the fold on mobile
  // -- rather than waiting on the Promise.all below. The dashboard's summary
  // tiles are fetched first in that Promise.all (loadHomeDashboardTiles),
  // ahead of every module panel's own load, per the "rendered first" plan
  // requirement; each tile's fetch is still independent of the others (see
  // loadHomeDashboardTiles) and of every panel's own load below.
  renderQuickActions();

  try {
    await Promise.all([
      loadHomeDashboardTiles(),
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

// --- Home dashboard (P-3) ---------------------------------------------------
// Quick-action buttons + summary tiles rendered above every module panel.
// Pure selection/shaping logic lives in home-dashboard.mjs (buildQuickActions,
// buildTiles, computeTodayShiftsForMe); everything here is I/O (apiFetch) and
// DOM (el()) glue.

// Mirrors hasPerm()'s platform-admin bypass for the fixed set of permission
// codes home-dashboard.mjs's quick actions/tiles ever check: a platform admin
// has no membership row (hence no `permissions` array) for a facility they
// don't belong to, so hasPerm() special-cases them to "always allowed"
// instead of reading `permissions` at all -- this passes the pure functions
// below the equivalent of "every code", rather than teaching them their own
// platformAdmin bypass.
function homeDashboardPermissions() {
  if (platformAdmin) return HOME_DASHBOARD_PERMISSION_CODES;
  const facility = currentFacilityRecord();
  return (facility && facility.permissions) || [];
}

// Scrolls a module panel into view and, since every panel is a <details>
// (collapsed by default under 640px, see collapsePanelsOnMobile), opens it
// first so scrolling doesn't land on a collapsed, empty-looking section.
function revealPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (panel.tagName === "DETAILS") panel.open = true;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleQuickAction(action) {
  revealPanel(action.panelId);
  if (action.key === "log-incident") {
    incidentsPanel.openCreate();
  } else if (action.key === "new-work-order") {
    workOrdersPanel.openCreate();
  } else if (action.key === "submit-report" && publishedReportTemplates.length === 1) {
    // Exactly one published template: skip the extra tap and open its draft
    // directly. With more than one, there's no single right choice --
    // revealPanel above has already scrolled the reports panel's template
    // list into view for the caller to pick from.
    startNewReport(publishedReportTemplates[0]);
  }
}

function renderQuickActions() {
  const container = document.getElementById("home-quick-actions");
  if (!container || !currentFacility) return;
  container.textContent = "";
  const actions = buildQuickActions(homeDashboardPermissions());
  for (const action of actions) {
    const btn = el("button", { type: "button", class: "primary quick-action-btn" }, action.label);
    btn.addEventListener("click", () => handleQuickAction(action));
    container.append(btn);
  }
}

// Resolves messages that still need the caller's own acknowledgement:
// published, is_required_ack messages this facility has, minus whichever of
// those the caller has already acked (checked per-message via the same
// GET .../messages/:id/acknowledgements?employeeId=me route commsPanel's own
// seedAckStateForVisibleMessages uses). A per-message ack-check failure is
// treated as "already acked" (excluded) rather than "still needs it", so a
// transient error on one message never inflates the tile's count -- the
// worst case is silently under-counting one message, not over-alarming.
async function loadUnackedMessages() {
  const messages = (await apiFetch(`/facilities/${currentFacility}/messages?status=published`)) || [];
  const requiredAck = messages.filter((message) => message.is_required_ack);
  if (requiredAck.length === 0) return [];
  const ackedFlags = await Promise.all(
    requiredAck.map((message) =>
      apiFetch(`/facilities/${currentFacility}/messages/${message.id}/acknowledgements?employeeId=me`)
        .then((rows) => ackedMessageIdsFromRows(rows).size > 0)
        .catch(() => true)
    )
  );
  return requiredAck.filter((_, index) => !ackedFlags[index]);
}

// Resolves the caller's own shifts for `today`: the current Mon-Sun period
// (same facility-wide, department_id-null period schedulePanel's own
// reloadWeek() selects), its shifts, and its assignments, joined down to
// "mine, today" by home-dashboard.mjs's computeTodayShiftsForMe. Returns []
// (not an error) when the caller has no employee record in this facility --
// there is nothing "mine" to show, same convention as the work-orders tile.
async function loadTodayShifts(myEmployeeId, today) {
  if (!myEmployeeId) return [];
  const periods = (await apiFetch(`/facilities/${currentFacility}/schedule-periods`)) || [];
  const { weekStartDate } = weekBoundsFor(today);
  const period = periods.find((p) => p.week_start_date === weekStartDate && !p.department_id) || null;
  if (!period) return [];
  const [shifts, assignments] = await Promise.all([
    apiFetch(`/facilities/${currentFacility}/shifts?period_id=${period.id}`),
    apiFetch(`/facilities/${currentFacility}/shift-assignments?period_id=${period.id}`)
  ]);
  return computeTodayShiftsForMe({ shifts: shifts || [], assignments: assignments || [], myEmployeeId, today });
}

// Fires all six of the dashboard's data fetches independently (a permission
// the caller lacks skips its fetch entirely rather than requesting a 403;
// one that's held but fails is caught to null, which buildTiles renders as
// "Unavailable" for just that tile -- no fetch's failure blocks another's or
// blanks the rest of the page), then renders whatever buildTiles returns.
async function loadHomeDashboardTiles() {
  const container = document.getElementById("home-tiles");
  if (!container || !currentFacility) return;

  const permissions = homeDashboardPermissions();
  const permSet = new Set(permissions);
  const myEmployeeId = (currentFacilityRecord() || {}).employeeId || null;
  const today = new Date().toISOString().slice(0, 10);

  const [compliance, workOrders, incidents, unackedMessages, certifications, todayShifts] = await Promise.all([
    permSet.has("reports.read")
      ? apiFetch(`/facilities/${currentFacility}/reports/compliance?from=${today}&to=${today}`).catch(() => null)
      : Promise.resolve(null),
    permSet.has("work_orders.read")
      ? myEmployeeId
        ? apiFetch(
            `/facilities/${currentFacility}/work-orders?assignee=${encodeURIComponent(myEmployeeId)}&status=open`
          ).catch(() => null)
        : Promise.resolve([])
      : Promise.resolve(null),
    permSet.has("incidents.read")
      ? apiFetch(`/facilities/${currentFacility}/incidents?status=submitted`).catch(() => null)
      : Promise.resolve(null),
    permSet.has("communications.read") ? loadUnackedMessages().catch(() => null) : Promise.resolve(null),
    apiFetch(`/facilities/${currentFacility}/employee-certifications`).catch(() => null),
    permSet.has("schedule.read") ? loadTodayShifts(myEmployeeId, today).catch(() => null) : Promise.resolve(null)
  ]);

  renderTiles(
    container,
    buildTiles({ permissions, compliance, workOrders, incidents, unackedMessages, certifications, todayShifts, now: new Date() })
  );
}

function renderTiles(container, tiles) {
  container.textContent = "";
  if (tiles.length === 0) {
    container.append(el("p", { class: "item-subtitle" }, "No summary tiles available for your role yet."));
    return;
  }
  for (const tile of tiles) {
    const isUnavailable = tile.value === "Unavailable";
    const card = el(
      "button",
      {
        type: "button",
        class: "home-tile",
        "aria-label": `${tile.title}: ${tile.value}${tile.hint ? ", " + tile.hint : ""}`
      },
      [
        el("div", { class: "home-tile-title" }, tile.title),
        el("div", { class: isUnavailable ? "home-tile-value is-unavailable" : "home-tile-value" }, tile.value),
        el("div", { class: "home-tile-hint" }, tile.hint)
      ]
    );
    card.addEventListener("click", () => revealPanel(tile.panelId));
    container.append(card);
  }
}

// P-3: panels are <details>/<summary> disclosures so they can start
// collapsed on narrow viewports without hiding them from a caller with
// JavaScript disabled -- called once at startup (DOMContentLoaded, below),
// not re-run on resize, matching "start collapsed" rather than "stay in sync
// with the viewport forever".
function collapsePanelsOnMobile() {
  if (!window.matchMedia || window.matchMedia("(min-width: 640px)").matches) return;
  document.querySelectorAll("main > details.panel[open]").forEach((panel) => {
    panel.open = false;
  });
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

    // GET .../report-templates defaults to ?status=published (no ?status=all
    // here), so `templates` is already published-only -- safe to hand
    // straight to the home dashboard's quick action.
    publishedReportTemplates = templates || [];
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
// assignmentsByShiftId is seeded from the server on every reloadWeek() via
// GET .../shift-assignments?period_id= + indexAssignmentsByShift (P-2), so it
// reflects assignments made in another tab/session, not just this one.
// assignEmployee/unassign additionally update it optimistically so the card
// reflects the change immediately, without waiting on a full reload.
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
        const [shifts, assignments] = await Promise.all([
          apiFetch(`/facilities/${currentFacility}/shifts?period_id=${state.period.id}`),
          apiFetch(`/facilities/${currentFacility}/shift-assignments?period_id=${state.period.id}`)
        ]);
        state.shifts = shifts || [];
        state.assignmentsByShiftId = indexAssignmentsByShift(assignments || []);
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
      // Optimistic add: append the new row (same snake_case shape the GET
      // .../shift-assignments route returns) rather than waiting for a full
      // reloadWeek() round-trip.
      const existing = state.assignmentsByShiftId.get(shiftId) || [];
      state.assignmentsByShiftId.set(shiftId, [...existing, assignment]);
      state.formError = null;
      render();
    } catch (error) {
      state.formError = error.message;
      render();
    }
  }

  async function unassign(shiftId, assignmentId) {
    try {
      await apiFetch(`/facilities/${currentFacility}/shifts/${shiftId}/assignments/${assignmentId}`, {
        method: "PATCH",
        body: { status: "cancelled" }
      });
      const remaining = (state.assignmentsByShiftId.get(shiftId) || []).filter((a) => a.id !== assignmentId);
      if (remaining.length > 0) state.assignmentsByShiftId.set(shiftId, remaining);
      else state.assignmentsByShiftId.delete(shiftId);
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

    const assignments = state.assignmentsByShiftId.get(shift.id) || [];
    if (assignments.length > 0) {
      for (const assignment of assignments) {
        const row = el("div", { class: "item-subtitle" }, `Assigned: ${employeeLabel(assignment.employee_id)}`);
        if (hasPerm("schedule.manage")) {
          const unassignBtn = el("button", { type: "button" }, "Unassign");
          unassignBtn.addEventListener("click", () => unassign(shift.id, assignment.id));
          row.append(unassignBtn);
        }
        card.append(row);
      }
    } else {
      card.append(el("span", { class: "item-subtitle" }, "Unassigned"));
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
// (acknowledge/resolve), amendment history (clearly labeled immutable),
// people involved + witness statement history (IN-12), and attachments.
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
    amendErrors: {},
    // IN-12: people involved + their witness statement history.
    people: [],
    peopleError: null,
    personOpen: false,
    personFields: { personRole: "", fullName: "" },
    personErrors: {},
    // Statement history/composer state, keyed by person id, so multiple
    // people's histories can be loaded/expanded independently.
    statementsByPersonId: {},
    statementErrorsByPersonId: {},
    openPersonId: null,
    statementFieldByPersonId: {},
    statementFieldErrorsByPersonId: {}
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
    state.people = [];
    state.peopleError = null;
    state.personOpen = false;
    state.personFields = { personRole: "", fullName: "" };
    state.personErrors = {};
    state.statementsByPersonId = {};
    state.statementErrorsByPersonId = {};
    state.openPersonId = null;
    state.statementFieldByPersonId = {};
    state.statementFieldErrorsByPersonId = {};
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
    state.people = [];
    state.peopleError = null;
    state.personOpen = false;
    state.personFields = { personRole: "", fullName: "" };
    state.personErrors = {};
    state.statementsByPersonId = {};
    state.statementErrorsByPersonId = {};
    state.openPersonId = null;
    state.statementFieldByPersonId = {};
    state.statementFieldErrorsByPersonId = {};
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
    await loadPeople();
    render();
  }

  function closeDetail() {
    state.detailId = null;
    state.detail = null;
    render();
  }

  // --- People / witness statements (IN-12) ----------------------------------
  async function loadPeople() {
    if (!currentFacility || !state.detailId) return;
    try {
      state.people = (await apiFetch(`/facilities/${currentFacility}/incidents/${state.detailId}/people`)) || [];
      state.peopleError = null;
    } catch (error) {
      state.peopleError = error.message;
    }
  }

  async function submitPerson() {
    const validation = validatePersonInput(state.personFields);
    state.personErrors = validation.errors;
    if (!validation.valid) {
      render();
      return;
    }
    try {
      const created = await apiFetch(`/facilities/${currentFacility}/incidents/${state.detailId}/people`, {
        method: "POST",
        body: buildPersonPayload(state.personFields)
      });
      state.people.push(created);
      state.personOpen = false;
      state.personFields = { personRole: "", fullName: "" };
      state.personErrors = {};
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function removePerson(personId) {
    try {
      await apiFetch(`/facilities/${currentFacility}/incidents/${state.detailId}/people/${personId}`, {
        method: "DELETE"
      });
      state.people = state.people.filter((p) => p.id !== personId);
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function togglePersonStatements(personId) {
    if (state.openPersonId === personId) {
      state.openPersonId = null;
      render();
      return;
    }
    state.openPersonId = personId;
    if (!state.statementFieldByPersonId[personId]) {
      state.statementFieldByPersonId[personId] = { statementText: "" };
    }
    render();
    if (!state.statementsByPersonId[personId]) {
      try {
        state.statementsByPersonId[personId] =
          (await apiFetch(
            `/facilities/${currentFacility}/incidents/${state.detailId}/people/${personId}/statements`
          )) || [];
        delete state.statementErrorsByPersonId[personId];
      } catch (error) {
        state.statementErrorsByPersonId[personId] = error.message;
      }
      render();
    }
  }

  async function submitStatement(personId) {
    const fields = state.statementFieldByPersonId[personId] || { statementText: "" };
    const validation = validateStatementInput(fields);
    state.statementFieldErrorsByPersonId[personId] = validation.errors;
    if (!validation.valid) {
      render();
      return;
    }
    try {
      const created = await apiFetch(
        `/facilities/${currentFacility}/incidents/${state.detailId}/people/${personId}/statements`,
        { method: "POST", body: buildStatementPayload(fields) }
      );
      const existing = state.statementsByPersonId[personId] || [];
      state.statementsByPersonId[personId] = [...existing, created];
      state.statementFieldByPersonId[personId] = { statementText: "" };
      state.statementFieldErrorsByPersonId[personId] = {};
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
  }

  async function signStatement(personId, statementId) {
    try {
      const updated = await apiFetch(
        `/facilities/${currentFacility}/incidents/${state.detailId}/people/${personId}/statements/${statementId}/sign`,
        { method: "POST" }
      );
      const existing = state.statementsByPersonId[personId] || [];
      state.statementsByPersonId[personId] = existing.map((s) => (s.id === statementId ? updated : s));
      state.detailActionError = null;
      render();
    } catch (error) {
      state.detailActionError = error.message;
      render();
    }
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

  // --- People / witness statements (IN-12) ----------------------------------
  function buildPersonForm() {
    const wrap = el("div", { class: "inline-form" });
    const roleSelect = document.createElement("select");
    roleSelect.append(el("option", { value: "" }, "Role"));
    for (const role of INCIDENT_PERSON_ROLES) {
      const opt = el("option", { value: role }, role.replace(/_/g, " "));
      if (state.personFields.personRole === role) opt.selected = true;
      roleSelect.append(opt);
    }
    roleSelect.addEventListener("change", () => (state.personFields.personRole = roleSelect.value));
    const nameInput = el("input", { type: "text", placeholder: "Full name", value: state.personFields.fullName });
    nameInput.addEventListener("input", () => (state.personFields.fullName = nameInput.value));
    const errorText = [state.personErrors.personRole, state.personErrors.fullName].filter(Boolean).join(" ");
    const errorEl = el("p", { class: "rr-error" }, errorText);
    const submitBtn = el("button", { type: "button", class: "primary" }, "Add person");
    submitBtn.addEventListener("click", () => submitPerson());
    wrap.append(roleSelect, nameInput, submitBtn, errorEl);
    return wrap;
  }

  // contact_json is an open, free-form object -- rendered as
  // "key: value" pairs joined by commas rather than assuming any particular
  // shape, since nothing in the schema constrains its keys.
  function formatContact(contactJson) {
    const entries = Object.entries(contactJson || {});
    if (entries.length === 0) return "No contact info on file.";
    return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
  }

  function buildStatementComposer(personId) {
    const fields = state.statementFieldByPersonId[personId] || { statementText: "" };
    const errors = state.statementFieldErrorsByPersonId[personId] || {};
    const wrap = el("div", { class: "inline-form" });
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Statement text";
    textarea.value = fields.statementText;
    textarea.addEventListener("input", () => (fields.statementText = textarea.value));
    state.statementFieldByPersonId[personId] = fields;
    if (errors.statementText) wrap.append(el("p", { class: "rr-error" }, errors.statementText));
    const submitBtn = el("button", { type: "button" }, "Add statement");
    submitBtn.addEventListener("click", () => submitStatement(personId));
    wrap.append(textarea, submitBtn);
    return wrap;
  }

  function buildStatementHistory(person) {
    const wrap = el("div", { class: "module-section" });
    const statementError = state.statementErrorsByPersonId[person.id];
    if (statementError) wrap.append(el("p", { class: "rr-error" }, statementError));
    const statements = state.statementsByPersonId[person.id];
    if (!statements) {
      wrap.append(el("p", { class: "item-subtitle" }, "Loading statements…"));
      return wrap;
    }
    if (statements.length === 0) {
      wrap.append(el("p", { class: "item-subtitle" }, "No statements recorded yet."));
    }
    const anySigned = statements.some((s) => s.signed_at);
    for (const statement of statements) {
      const row = el("div", { class: "module-item" });
      row.append(el("div", { class: "item-title" }, `Version ${statement.version_no}`));
      row.append(el("div", { class: "item-subtitle" }, statement.statement_text));
      row.append(
        el(
          "div",
          { class: "item-subtitle" },
          statement.signed_at
            ? `Signed ${new Date(statement.signed_at).toLocaleString()}`
            : `Submitted ${new Date(statement.submitted_at).toLocaleString()}`
        )
      );
      if (!statement.signed_at && (hasPerm("incidents.manage") || hasPerm("incidents.review"))) {
        const signBtn = el("button", { type: "button" }, "Sign");
        signBtn.addEventListener("click", () => signStatement(person.id, statement.id));
        row.append(signBtn);
      }
      wrap.append(row);
    }
    if (!anySigned && (hasPerm("incidents.manage") || hasPerm("incidents.review"))) {
      wrap.append(buildStatementComposer(person.id));
    } else if (anySigned) {
      wrap.append(el("p", { class: "item-subtitle" }, "A signed statement exists; no further versions may be added."));
    }
    return wrap;
  }

  function buildPeopleSection() {
    const wrap = el("div", {});
    if (state.peopleError) wrap.append(el("p", { class: "rr-error" }, state.peopleError));
    if (state.people.length === 0) wrap.append(el("p", { class: "item-subtitle" }, "No people recorded for this incident."));
    for (const person of state.people) {
      const row = el("div", { class: "module-item" });
      row.append(el("div", { class: "item-title" }, `${person.full_name} · ${person.person_role.replace(/_/g, " ")}`));
      row.append(el("div", { class: "item-subtitle" }, formatContact(person.contact_json)));
      const rowActions = el("div", { class: "detail-actions" });
      const historyBtn = el(
        "button",
        { type: "button" },
        state.openPersonId === person.id ? "Hide statements" : "Statements"
      );
      historyBtn.addEventListener("click", () => togglePersonStatements(person.id));
      rowActions.append(historyBtn);
      if (hasPerm("incidents.manage") || hasPerm("incidents.review")) {
        const removeBtn = el("button", { type: "button" }, "Remove");
        removeBtn.addEventListener("click", () => removePerson(person.id));
        rowActions.append(removeBtn);
      }
      row.append(rowActions);
      if (state.openPersonId === person.id) row.append(buildStatementHistory(person));
      wrap.append(row);
    }
    if (hasPerm("incidents.manage") || hasPerm("incidents.review")) {
      const toggleBtn = el("button", { type: "button" }, state.personOpen ? "Cancel" : "Add person");
      toggleBtn.addEventListener("click", () => {
        state.personOpen = !state.personOpen;
        render();
      });
      wrap.append(toggleBtn);
      if (state.personOpen) wrap.append(buildPersonForm());
    }
    return wrap;
  }

  const INCIDENT_NEXT_STATUS_CHOICES = ["under_review", "escalated", "action_pending", "closed"];

  function renderDetail() {
    // P-8: a static id, safe because only one incident detail is ever open
    // at a time -- lets the global search box scroll straight to it after
    // calling openDetail() below.
    const panel = el("div", { class: "report-form-area incident-detail", id: "incident-detail-panel" });
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
    panel.append(buildPeopleSection());

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

  // Opens the "Report new incident" capture form (P-3's "Log incident" quick
  // action): same gate as the toggle button in render() above, so a caller
  // without incidents.manage silently does nothing rather than a form
  // magically appearing that submitCapture's own POST would 403 on anyway.
  function openCreate() {
    if (!hasPerm("incidents.manage")) return;
    state.captureOpen = true;
    render();
  }

  // openDetail exposed for P-8 (global search): its own "View" button
  // above already calls it internally; the search box's incidents leg
  // calls the same function to deep-link into a matched incident.
  return { load, reset, openCreate, openDetail };
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
    // P-8: a static id (only one work order detail is ever open at a
    // time) so the global search box can scroll straight to it after
    // calling openDetail() below.
    const panel = el("div", { class: "report-form-area work-order-detail", id: "work-order-detail-panel" });
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

  // Opens the "New work order" create form (P-3's "New work order" quick
  // action): same gate as the toggle button in render() above.
  function openCreate() {
    if (!hasPerm("work_orders.manage")) return;
    state.createOpen = true;
    render();
  }

  // openDetail exposed for P-8 (global search): the search box's work
  // orders leg calls the same function its own "View" button uses.
  return { load, reset, openCreate, openDetail };
})();

// --- Communications module (CM-08/CM-09/P-1) -----------------------------------
// Compose form (channel/audience/priority/required-ack) posting through the
// draft-then-publish flow (CM-03), a paginated message list that auto-marks
// delivered/read receipts as it renders, a per-viewer ack-state badge, and
// (P-1) server-seeded ack state plus per-message compliance counts for
// publishers/authors.
//
// ackedMessageIds is seeded from GET .../acknowledgements?employeeId=me for
// every visible message (seedAckStateForVisibleMessages, mirroring how
// markReceiptsForVisibleMessages already marks receipts) as it renders, so
// an acknowledgement made in an earlier session still renders as complete --
// it is no longer session-local, just checked lazily per page of messages
// rather than fetched in one facility-wide call (there is no such bulk
// endpoint; P-1 only added the per-message one).
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
    myEmployeeId: null,
    ackedMessageIds: new Set(),
    ackCheckedIds: new Set(),
    receiptSentIds: new Set(),
    complianceByMessageId: {},
    complianceCheckedIds: new Set(),
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
      // GET /facilities/:id/employees is registered by the scheduling module
      // (gated on schedule.read) but serves as the facility's employee
      // directory app-wide -- reused here (same pattern as the work orders
      // panel's "Mine" chip) only to resolve the caller's own employees.id,
      // for deciding which messages' compliance counts to show.
      const employees = await apiFetch(`/facilities/${currentFacility}/employees`).catch(() => []);
      state.myEmployeeId = ((employees || []).find((e) => e.user_id === (currentUser && currentUser.id)) || {}).id || null;
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
    state.myEmployeeId = null;
    state.ackedMessageIds = new Set();
    state.ackCheckedIds = new Set();
    state.receiptSentIds = new Set();
    state.complianceByMessageId = {};
    state.complianceCheckedIds = new Set();
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

  // P-1: seeds state.ackedMessageIds from the server (GET .../acknowledgements
  // ?employeeId=me) for every message about to render, once per message id
  // per panel load (ackCheckedIds, same dedup shape as receiptSentIds). Unlike
  // markReceiptsForVisibleMessages this re-renders once every check settles,
  // since learning "the caller already acknowledged this" flips the message
  // card's badge and hides its Acknowledge button -- ackCheckedIds already
  // holds every id involved by then, so that re-render's own call back into
  // this function is a same-tick no-op rather than a fetch loop.
  async function seedAckStateForVisibleMessages(messages) {
    const toCheck = messages.filter((message) => !state.ackCheckedIds.has(message.id));
    if (toCheck.length === 0) return;
    for (const message of toCheck) state.ackCheckedIds.add(message.id);
    await Promise.all(
      toCheck.map((message) =>
        apiFetch(`/facilities/${currentFacility}/messages/${message.id}/acknowledgements?employeeId=me`)
          .then((rows) => {
            if (ackedMessageIdsFromRows(rows).size > 0) state.ackedMessageIds.add(message.id);
          })
          .catch(() => {})
      )
    );
    render();
  }

  // P-1: fetches the compliance rollup (delivered/read/acknowledged/pending/
  // overdue/total) for every visible message shouldFetchCompliance says this
  // viewer should see counts for (their own sends, or any message at all when
  // they hold communications.publish), once per message id per panel load
  // (complianceCheckedIds, same dedup/re-render shape as
  // seedAckStateForVisibleMessages above).
  async function loadComplianceForVisibleMessages(messages) {
    const canPublish = hasPerm("communications.publish");
    const toFetch = messages.filter(
      (message) =>
        !state.complianceCheckedIds.has(message.id) &&
        shouldFetchCompliance(message, { canPublish, myEmployeeId: state.myEmployeeId })
    );
    if (toFetch.length === 0) return;
    for (const message of toFetch) state.complianceCheckedIds.add(message.id);
    await Promise.all(
      toFetch.map((message) =>
        apiFetch(`/facilities/${currentFacility}/messages/${message.id}/compliance`)
          .then((summary) => {
            state.complianceByMessageId[message.id] = summary;
          })
          .catch(() => {})
      )
    );
    render();
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
    // P-8: an id per card (messages have no dedicated detail view the way
    // incidents/work orders do) so the global search box can scroll to and
    // highlight the specific card when it's on the currently rendered
    // page; when it isn't (client-side pagination, P-1), the search box
    // falls back to scrolling to the panel itself.
    const card = el("div", { class: "message-card", id: `message-card-${message.id}` });
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

    // P-1: a compliance count (e.g. "2/5 acknowledged, 1 overdue") for
    // whoever shouldFetchCompliance says gets to see it -- the message's own
    // author, or anyone holding communications.publish. Absent until its
    // background fetch (loadComplianceForVisibleMessages) settles.
    const complianceText = formatComplianceSummary(state.complianceByMessageId[message.id]);
    if (complianceText) card.append(el("div", { class: "item-subtitle" }, complianceText));

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
      seedAckStateForVisibleMessages(pageItems);
      loadComplianceForVisibleMessages(pageItems);
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

// Sign out handler. Revokes the refresh token upstream first (which also
// clears the rr_refresh cookie server-side) so the session cannot be resumed
// elsewhere, then clears local storage and redirects. The local clear runs
// even if revocation fails, so signing out always works. Called unconditionally
// -- even with no access token -- so the cookie is cleared either way.
function setupSignOut() {
  const signOutBtn = document.getElementById("sign-out-btn");
  if (!signOutBtn) return;
  signOutBtn.addEventListener("click", async () => {
    signOutBtn.disabled = true;
    const token = getToken();
    try {
      await fetch(`${API_BASE}/auth/sign-out`, {
        method: "POST",
        credentials: "same-origin",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json" }
      });
    } catch {
      // Ignore: the local clear below is what signs this browser out.
    }
    clearAuthAndRedirect();
  });
}

// --- Global search (P-8) ----------------------------------------------------
// Header search box: debounced GET /api/v1/search?facilityId=&q=, grouped
// results (incidents/work orders/employees/messages, only the legs the
// server included -- see search.mjs's groupResults), each deep-linking into
// its panel. Every DOM node is built with el() (never innerHTML with
// interpolation -- see el()'s doc comment above), so a result's own text
// (an incident summary, a message subject, ...) can never be parsed as
// markup even though it is attacker-influenced content from another user
// in the same facility.

// Container each leg's results scroll to. Employees have no dedicated list
// panel of their own (scheduling-routes.mjs's employees endpoint backs the
// schedule board -- see search-routes.mjs's leg comment), so that leg
// scrolls to the schedule panel; incidents/work orders additionally open
// their own detail view (openDetail, exposed above) once scrolled to;
// messages have no detail view, so the specific message card is
// highlighted instead when it's on the currently rendered page.
const SEARCH_LEG_CONTAINER_ID = {
  incidents: "incidents-workspace",
  workOrders: "work-orders-workspace",
  employees: "schedule-workspace",
  messages: "comms-workspace"
};

function scrollElementIntoView(elementId, options) {
  const target = document.getElementById(elementId);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start", ...options });
  return target;
}

// Briefly outlines `target` so a deep-linked result is visually obvious
// after the scroll lands, then removes the outline -- a transient cue, not
// a persistent style change.
function flashSearchHighlight(target) {
  if (!target) return;
  target.classList.add("search-result-highlight");
  setTimeout(() => target.classList.remove("search-result-highlight"), 2000);
}

function searchResultPrimaryText(legKey, item) {
  switch (legKey) {
    case "incidents":
      return `${item.incident_no || "Incident"} · ${item.summary || ""}`;
    case "workOrders":
      return item.title || "Work order";
    case "employees":
      return `${item.first_name || ""} ${item.last_name || ""}`.trim() || item.employee_no || "Employee";
    case "messages":
      return item.subject || "Message";
    default:
      return "";
  }
}

function searchResultSecondaryText(legKey, item) {
  switch (legKey) {
    case "incidents":
      return item.location_text || (item.status ? `Status: ${item.status}` : "");
    case "workOrders":
      return item.status ? `Status: ${item.status}` : item.description || "";
    case "employees":
      return item.employee_no ? `#${item.employee_no}` : item.status || "";
    case "messages":
      return (item.body_text || "").slice(0, 100);
    default:
      return "";
  }
}

// Registers the header search box: reads/writes only #global-search's own
// subtree plus the four panel containers it deep-links into, and the
// module-level `currentFacility` every other panel already relies on --
// no new global state of its own.
function setupGlobalSearch() {
  const wrapper = document.getElementById("global-search");
  const input = document.getElementById("global-search-input");
  const resultsEl = document.getElementById("global-search-results");
  if (!wrapper || !input || !resultsEl) return;

  function closeResults() {
    resultsEl.hidden = true;
    resultsEl.textContent = "";
    input.setAttribute("aria-expanded", "false");
  }

  function renderStatus(text, { isError = false } = {}) {
    resultsEl.textContent = "";
    resultsEl.append(el("p", { class: isError ? "global-search-status rr-error" : "global-search-status" }, text));
    resultsEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  async function openResult(legKey, item) {
    closeResults();
    const container = scrollElementIntoView(SEARCH_LEG_CONTAINER_ID[legKey]);
    if (legKey === "incidents" && incidentsPanel.openDetail) {
      await incidentsPanel.openDetail(item.id);
      flashSearchHighlight(scrollElementIntoView("incident-detail-panel") || container);
    } else if (legKey === "workOrders" && workOrdersPanel.openDetail) {
      await workOrdersPanel.openDetail(item.id);
      flashSearchHighlight(scrollElementIntoView("work-order-detail-panel") || container);
    } else if (legKey === "messages") {
      const card = document.getElementById(`message-card-${item.id}`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        flashSearchHighlight(card);
      } else {
        flashSearchHighlight(container);
      }
    } else {
      flashSearchHighlight(container);
    }
  }

  function renderResults(groups) {
    resultsEl.textContent = "";
    if (groups.length === 0) {
      renderStatus("No matches.");
      return;
    }
    for (const group of groups) {
      resultsEl.append(el("div", { class: "global-search-group-label" }, group.label));
      for (const item of group.items) {
        const row = el(
          "button",
          { type: "button", class: "global-search-result", role: "option" },
          [
            el("span", { class: "global-search-result-title" }, searchResultPrimaryText(group.key, item)),
            el("span", { class: "global-search-result-subtitle" }, searchResultSecondaryText(group.key, item))
          ]
        );
        row.addEventListener("click", () => openResult(group.key, item));
        resultsEl.append(row);
      }
    }
    resultsEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  // Guards against an in-flight response landing after the input has moved
  // on to a different (or cleared) query -- sanitizeQuery is a pure,
  // deterministic function of the input's CURRENT value, so re-deriving
  // and comparing here is enough to detect that without any request-id
  // bookkeeping.
  async function runSearch(rawValue) {
    const q = sanitizeQuery(rawValue);
    if (!q || !currentFacility) {
      closeResults();
      return;
    }
    renderStatus("Searching…");
    try {
      const payload = await apiFetch(`/search?facilityId=${encodeURIComponent(currentFacility)}&q=${encodeURIComponent(q)}`);
      if (sanitizeQuery(input.value) !== q) return; // stale response
      renderResults(groupResults(payload));
    } catch (error) {
      if (sanitizeQuery(input.value) !== q) return; // stale response
      renderStatus(error.message || "Search failed", { isError: true });
    }
  }

  // P-8: >=300ms debounce, and only ever fires for a sanitized q of at
  // least 2 characters (sanitizeQuery's own MIN_QUERY_LENGTH) -- a shorter
  // or entirely-reserved-characters value closes the dropdown immediately
  // instead of debouncing a search the server would just 400 anyway.
  const debouncedSearch = debounce(runSearch, 300);

  input.addEventListener("input", (event) => {
    const value = event.target.value;
    if (sanitizeQuery(value) === null) {
      debouncedSearch.cancel();
      closeResults();
      return;
    }
    debouncedSearch(value);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      debouncedSearch.cancel();
      closeResults();
      input.blur();
    }
  });

  document.addEventListener("click", (event) => {
    if (!wrapper.contains(event.target)) closeResults();
  });
}

// Start app on load
document.addEventListener("DOMContentLoaded", () => {
  setupSignOut();
  collapsePanelsOnMobile();
  setupGlobalSearch();
  migrateLegacyRefreshToken().finally(initialize);
});
