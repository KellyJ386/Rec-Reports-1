import { api, getToken, setToken, hasToken, signOut } from "./api.js";
import { getContext, setContext, setFacilities, subscribe } from "./state.js";
import { toast, clearChildren, el } from "./ui.js";
import { loadMe } from "./session.js";
import { initRouter, closeSidebarOnNavigate } from "./nav.js";

// Top-bar "N unpublished changes" indicator: counts this facility's
// admin_change_requests rows whose status isn't 'published' yet. Refreshed on
// every hash navigation (page switch) and every shared-state change (facility
// switch, /me resolving), so it never shows a stale count for the wrong
// facility.
async function refreshUnpublishedBadge() {
  const badge = document.getElementById("unpublished-badge");
  if (!badge) return;
  const context = getContext();
  if (!context.facilityId) {
    badge.hidden = true;
    return;
  }
  try {
    const rows = (await api.get(`/facilities/${encodeURIComponent(context.facilityId)}/change-requests`)) ?? [];
    const count = rows.filter((row) => row.status !== "published").length;
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = `${count} unpublished change${count === 1 ? "" : "s"}`;
    } else {
      badge.hidden = true;
    }
  } catch {
    // Best-effort indicator: a failed lookup (no token yet, no permission on
    // this facility, network error) just hides the badge rather than erroring.
    badge.hidden = true;
  }
}

function wireSidebarToggle() {
  const toggle = document.getElementById("sidebar-toggle");
  const sidebar = document.getElementById("sidebar");
  if (!toggle || !sidebar) return;
  toggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  closeSidebarOnNavigate();
}

function wireTokenDrawer() {
  const drawer = document.getElementById("token-drawer");
  const toggleButton = document.getElementById("token-drawer-toggle");
  const closeButton = document.getElementById("token-drawer-close");
  const input = document.getElementById("token-input");
  const saveButton = document.getElementById("token-save");
  const clearButton = document.getElementById("token-clear");
  const status = document.getElementById("token-status");
  if (!drawer || !toggleButton || !input || !saveButton || !clearButton) return;

  input.value = getToken();

  function openDrawer() {
    drawer.hidden = false;
    toggleButton.setAttribute("aria-expanded", "true");
    input.focus();
  }
  function closeDrawer() {
    drawer.hidden = true;
    toggleButton.setAttribute("aria-expanded", "false");
    toggleButton.focus();
  }

  toggleButton.addEventListener("click", () => {
    if (drawer.hidden) openDrawer();
    else closeDrawer();
  });
  closeButton?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !drawer.hidden) closeDrawer();
  });

  saveButton.addEventListener("click", async () => {
    setToken(input.value.trim());
    status.textContent = hasToken() ? "Token saved." : "Token cleared (empty value).";
    toast("Session token saved.", { tone: "success" });
    await loadMe({ force: true });
  });

  clearButton.addEventListener("click", async () => {
    setToken("");
    input.value = "";
    status.textContent = "Token cleared.";
    toast("Session token cleared.", { tone: "info" });
    await loadMe({ force: true });
  });
}

// Clears both stored tokens and returns to the sign-in page. The session
// token drawer stays available as a debug tool for pasting raw tokens.
function wireSignOut() {
  const button = document.getElementById("sign-out");
  if (!button) return;
  button.addEventListener("click", () => {
    toast("Signed out.", { tone: "info" });
    signOut();
  });
}

async function refreshFacilitySelect() {
  const select = document.getElementById("facility-select");
  if (!select) return;
  const context = getContext();
  if (!context.orgId) {
    select.disabled = true;
    clearChildren(select);
    select.append(el("option", { value: "" }, ["All facilities"]));
    return;
  }
  try {
    const facilities = (await api.get(`/org/${encodeURIComponent(context.orgId)}/facilities`)) ?? [];
    setFacilities(facilities);
    clearChildren(select);
    select.append(el("option", { value: "" }, ["All facilities"]));
    for (const facility of facilities) {
      select.append(el("option", { value: facility.id }, [facility.name ?? facility.id]));
    }
    select.value = context.facilityId ?? "";
    select.disabled = false;
  } catch {
    select.disabled = true;
  }
}

function wireContextControls() {
  const orgInput = document.getElementById("org-input");
  const facilitySelect = document.getElementById("facility-select");
  if (!orgInput || !facilitySelect) return;

  const context = getContext();
  orgInput.value = context.orgId ?? "";

  let debounceTimer = null;
  orgInput.addEventListener("input", () => {
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      setContext({ orgId: orgInput.value.trim(), facilityId: "" });
      refreshFacilitySelect();
    }, 400);
  });

  facilitySelect.addEventListener("change", () => {
    setContext({ facilityId: facilitySelect.value });
  });

  refreshFacilitySelect();
}

function wireUnpublishedBadge() {
  window.addEventListener("hashchange", () => refreshUnpublishedBadge());
  subscribe(() => refreshUnpublishedBadge());
  refreshUnpublishedBadge();
}

async function bootstrap() {
  wireSidebarToggle();
  wireTokenDrawer();
  wireSignOut();
  wireContextControls();
  wireUnpublishedBadge();
  await loadMe();
  initRouter();
}

bootstrap();
