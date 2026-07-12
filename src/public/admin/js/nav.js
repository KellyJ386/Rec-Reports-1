// Hash-based client-side router. The left nav's 10 groups are static markup
// in admin/index.html (progressive enhancement + satisfies no-JS baseline);
// this module only toggles visibility/active state on that existing markup
// and swaps the page content region. Nav visibility is permission-driven:
// each restricted item carries [data-requires-permission="<code>"] naming the
// permission code its page's primary API actually checks (see the route
// files under src/lib/http/), and is hidden unless the signed-in user holds
// that exact code on any active membership. Dashboard carries no requirement
// and is always visible.

import { clearChildren, errorBanner } from "./ui.js";
import { hasPermissionAnywhere, subscribe } from "./state.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderModules } from "./pages/modules.js";
import { renderFacilities } from "./pages/facilities.js";
import { renderIdentity } from "./pages/identity.js";
import { renderAudit } from "./pages/audit.js";
import { renderBranding } from "./pages/branding.js";
import { renderForms } from "./pages/forms.js";
import { renderNotifications } from "./pages/notifications.js";
import { renderCertifications } from "./pages/certifications.js";
import { renderBilling } from "./pages/billing.js";

// id -> { label } for every nav group. Every group now has a real renderer in
// PAGE_RENDERERS below (Phase 7 completed the last stubs: certifications, billing).
const GROUP_META = {
  dashboard: { label: "Dashboard" },
  modules: { label: "Modules & Features" },
  identity: { label: "Identity & Permissions" },
  forms: { label: "Forms & Fields" },
  notifications: { label: "Notifications" },
  facilities: { label: "Facilities & Departments" },
  certifications: { label: "Certifications" },
  branding: { label: "Branding & Documents" },
  audit: { label: "Audit & Compliance" },
  billing: { label: "Billing & Subscription" }
};

const PAGE_RENDERERS = {
  dashboard: renderDashboard,
  modules: renderModules,
  identity: renderIdentity,
  facilities: renderFacilities,
  audit: renderAudit,
  branding: renderBranding,
  forms: renderForms,
  notifications: renderNotifications,
  certifications: renderCertifications,
  billing: renderBilling
};

function currentRouteId() {
  const hash = window.location.hash || "#/dashboard";
  const match = /^#\/([a-z]+)/.exec(hash);
  const id = match ? match[1] : "dashboard";
  return GROUP_META[id] ? id : "dashboard";
}

function isVisible(id) {
  const item = document.querySelector(`li[data-nav-id="${id}"]`);
  if (!item || !item.hasAttribute("data-requires-permission")) return true;
  const code = item.getAttribute("data-requires-permission");
  return hasPermissionAnywhere(code);
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

  const renderer = PAGE_RENDERERS[id];
  if (!renderer) {
    container.append(errorBanner(`No page is registered for ${meta.label}.`));
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
