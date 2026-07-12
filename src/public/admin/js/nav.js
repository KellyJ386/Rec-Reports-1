// Hash-based client-side router. The left nav's 10 groups are static markup
// in admin/index.html (progressive enhancement + satisfies no-JS baseline);
// this module only toggles visibility/active state on that existing markup
// and swaps the page content region. Nav visibility is permission-driven:
// items marked [data-requires-admin] are hidden for users who don't hold
// admin.manage anywhere.

import { clearChildren, errorBanner } from "./ui.js";
import { hasAdminAccess, subscribe } from "./state.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderModules } from "./pages/modules.js";
import { renderFacilities } from "./pages/facilities.js";
import { renderIdentity } from "./pages/identity.js";
import { renderAudit } from "./pages/audit.js";
import { renderStub } from "./pages/stub.js";

// id -> { label, phase } for stub pages; pages already implemented are
// omitted from PAGE_RENDERERS lookup below instead of here.
const GROUP_META = {
  dashboard: { label: "Dashboard" },
  modules: { label: "Modules & Features" },
  identity: { label: "Identity & Permissions" },
  forms: { label: "Forms & Fields", phase: 7 },
  notifications: { label: "Notifications", phase: 7 },
  facilities: { label: "Facilities & Departments" },
  certifications: { label: "Certifications", phase: 7 },
  branding: { label: "Branding & Documents", phase: 6 },
  audit: { label: "Audit & Compliance" },
  billing: { label: "Billing & Subscription", phase: 7 }
};

const PAGE_RENDERERS = {
  dashboard: renderDashboard,
  modules: renderModules,
  identity: renderIdentity,
  facilities: renderFacilities,
  audit: renderAudit
};

function currentRouteId() {
  const hash = window.location.hash || "#/dashboard";
  const match = /^#\/([a-z]+)/.exec(hash);
  const id = match ? match[1] : "dashboard";
  return GROUP_META[id] ? id : "dashboard";
}

function isVisible(id) {
  const item = document.querySelector(`li[data-nav-id="${id}"]`);
  if (!item || !item.hasAttribute("data-requires-admin")) return true;
  return hasAdminAccess();
}

function renderNav() {
  const items = document.querySelectorAll("#nav-list li[data-nav-id]");
  const activeId = currentRouteId();
  items.forEach((item) => {
    const id = item.getAttribute("data-nav-id");
    const visible = isVisible(id);
    item.hidden = !visible;
    const link = item.querySelector("a");
    if (!link) return;
    const isActive = visible && id === activeId;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

async function renderRoute() {
  renderNav();
  const container = document.getElementById("page-content");
  if (!container) return;

  const id = currentRouteId();
  if (!isVisible(id)) {
    if (window.location.hash !== "#/dashboard") {
      window.location.hash = "#/dashboard";
      return;
    }
  }

  const meta = GROUP_META[id];
  clearChildren(container);
  container.focus();

  if (meta.phase) {
    renderStub(container, { title: meta.label, phase: meta.phase });
    return;
  }

  const renderer = PAGE_RENDERERS[id];
  if (!renderer) {
    renderStub(container, { title: meta.label, phase: "a later phase" });
    return;
  }

  try {
    await renderer(container);
  } catch (error) {
    clearChildren(container);
    container.append(errorBanner(`Could not load ${meta.label}: ${error.message}`));
  }
}

export function initRouter() {
  window.addEventListener("hashchange", () => {
    renderRoute();
  });
  // Re-render the current page whenever shared state changes (org/facility
  // context switch, session token save, /me resolving) so pages don't need
  // their own change-detection wiring.
  subscribe(() => {
    renderRoute();
  });
  if (!window.location.hash) {
    window.location.hash = "#/dashboard";
  }
  renderRoute();
}

export function closeSidebarOnNavigate() {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  if (!sidebar || !toggle) return;
  window.addEventListener("hashchange", () => {
    sidebar.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  });
}
