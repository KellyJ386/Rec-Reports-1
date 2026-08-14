const TOKEN_KEY = "rr_admin_token";
const REFRESH_TOKEN_KEY = "rr_refresh_token";
const API_BASE = "/api/v1";

// State
let currentUser = null;
let currentFacility = null;
let facilities = [];

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
    throw new Error(message);
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

  try {
    await Promise.all([
      loadReports(),
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
// but mirrors its auth/401/error-shape handling.
async function uploadAttachmentFile(path, file) {
  const token = getToken();
  const headers = {
    Accept: "application/json",
    "Content-Type": file.type || "application/octet-stream",
    "x-file-name": encodeURIComponent(file.name || "upload")
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

// Reports module
async function loadReports() {
  const container = document.getElementById("reports-list");
  if (!container) return;

  setLoading(container, true);
  try {
    const [templates, reports] = await Promise.all([
      apiFetch(`/facilities/${currentFacility}/report-templates`),
      apiFetch(`/facilities/${currentFacility}/reports`)
    ]);

    const templatesData = templates || [];
    const reportsData = reports || [];

    if (templatesData.length === 0 && reportsData.length === 0) {
      container.innerHTML = '<p>No reports or templates available.</p>';
      return;
    }

    let html = "";

    if (templatesData.length > 0) {
      html += '<div class="module-section"><strong>Available Templates:</strong></div>';
      for (const template of templatesData) {
        html += '<div class="module-item">';
        html += `<div>${escapeHtml(template.name)}</div>`;
        if (template.description) {
          html += `<div class="item-subtitle">${escapeHtml(template.description)}</div>`;
        }
        html += '</div>';
      }
    }

    if (reportsData.length > 0) {
      html += '<div class="module-section"><strong>Recent Submissions:</strong></div>';
      for (const report of reportsData) {
        html += '<div class="module-item">';
        html += `<div>${escapeHtml(report.status)} - ${escapeHtml(report.report_date)}</div>`;
        if (report.submitted_at) {
          html += `<div class="item-subtitle">Submitted ${new Date(report.submitted_at).toLocaleDateString()}</div>`;
        }
        html += attachmentsToggleMarkup("reports", report.id, { canUpload: report.status === "draft" });
        html += '</div>';
      }
    }

    container.innerHTML = html;
    wireAttachmentToggles(container);
  } catch (error) {
    setError(container, error.message);
  }
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
