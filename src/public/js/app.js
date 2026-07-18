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
      loadTraining()
    ]);
  } catch (error) {
    console.error("Error loading modules:", error);
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
        html += '</div>';
      }
    }

    container.innerHTML = html;
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
      html += '</div>';
    }

    container.innerHTML = html;
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
      html += '</div>';
    }

    container.innerHTML = html;
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
