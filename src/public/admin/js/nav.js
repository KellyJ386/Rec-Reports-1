// Hash-based client-side router plus the left-nav renderer. Nav visibility
// is permission-driven: pages that require admin.manage are hidden from the
// left nav (and redirected away from) for users who don't hold it anywhere.

import { el, clearChildren, errorBanner } from "./ui.js";
import { hasAdminAccess, subscribe } from "./state.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderModules } from "./pages/modules.js";
import { renderFacilities } from "./pages/facilities.js";
import { renderStub } from "./pages/stub.js";

export const NAV_GROUPS = [
  { id: "dashboard", label: "Dashboard", requiresAdmin: false },
  { id: "modules", label: "Modules & Features", requiresAdmin: true },
  { id: "identity", label: "Identity & Permissions", requiresAdmin: true, phase: 4 },
  { id: "forms", label: "Forms & Fields", requiresAdmin: true, phase: 7 },
  { id: "notifications", label: "Notifications", requiresAdmin: true, phase: 7 },
  { id: "facilities", label: "Facilities & Departments", requiresAdmin: true },
  { id: "certifications", label: "Certifications", requiresAdmin: true, phase: 7 },
  { id: "branding", label: "Branding & Documents", requiresAdmin: true, phase: 6 },
  { id: "audit", label: "Audit & Compliance", requiresAdmin: true, phase: 5 },
  { id: "billing", label: "Billing & Subscription", requiresAdmin: true, phase: 7 }
];

const PAGE_RENDERERS = {
  dashboard: renderDashboard,
  modules: renderModules,
  facilities: renderFacilities
};

function currentRouteId() {
  const hash = window.location.hash || "#/dashboard";
  const match = /^#\/([a-z]+)/.exec(hash);
  const id = match ? match[1] : "dashboard";
  return NAV_GROUPS.some((group) => group.id === id) ? id : "dashboard";
}

function isGroupVisible(group) {
  if (!group.requiresAdmin) return true;
  return hasAdminAccess();
}

function renderNav() {
  const list = document.getElementById("nav-list");
  if (!list) return;
  clearChildren(list);
  const activeId = currentRouteId();
  for (const group of NAV_GROUPS) {
    if (!isGroupVisible(group)) continue;
    const isActive = activeId === group.id;
    const link = el(
      "a",
      {
        href: `#/${group.id}`,
        class: isActive ? "nav-link active" : "nav-link",
        "aria-current": isActive ? "page" : undefined
      },
      [group.label]
    );
    list.append(el("li", { class: "nav-item" }, [link]));
  }
}

async function renderRoute() {
  renderNav();
  const container = document.getElementById("page-content");
  if (!container) return;

  const id = currentRouteId();
  const group = NAV_GROUPS.find((candidate) => candidate.id === id);

  if (!isGroupVisible(group)) {
    if (window.location.hash !== "#/dashboard") {
      window.location.hash = "#/dashboard";
      return;
    }
  }

  clearChildren(container);
  container.focus();

  if (group.phase) {
    renderStub(container, { title: group.label, phase: group.phase });
    return;
  }

  const renderer = PAGE_RENDERERS[id];
  if (!renderer) {
    renderStub(container, { title: group.label, phase: "a later phase" });
    return;
  }

  try {
    await renderer(container);
  } catch (error) {
    clearChildren(container);
    container.append(errorBanner(`Could not load ${group.label}: ${error.message}`));
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
