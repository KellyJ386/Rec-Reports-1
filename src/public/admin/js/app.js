import { api } from "./api.js";
import { hasToken, redirectToSignIn, signOut } from "./auth.js";
import { getContext, getMe, setContext, setFacilities, subscribe } from "./state.js";
import { clearChildren, el } from "./ui.js";
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

// Shows who is signed in and wires the sign-out button. The email comes from
// /me, so it reflects the token the API actually accepted rather than anything
// the browser typed in.
function wireSessionControl() {
  const emailSpan = document.getElementById("session-email");
  const signOutButton = document.getElementById("sign-out-button");

  signOutButton?.addEventListener("click", () => {
    signOutButton.disabled = true;
    signOut();
  });

  function render() {
    if (!emailSpan) return;
    const me = getMe();
    emailSpan.textContent = me.email ?? (me.loaded ? "unknown user" : "…");
  }

  subscribe(render);
  render();
}

// Organizations the signed-in user can act in, derived from the facilities /me
// returned. A platform admin sees every organization; everyone else sees the
// ones they hold a membership in.
function organizationsFromMe() {
  const byId = new Map();
  for (const facility of getMe().facilities ?? []) {
    if (!facility.organizationId || byId.has(facility.organizationId)) continue;
    byId.set(facility.organizationId, {
      id: facility.organizationId,
      name: facility.organizationName ?? facility.organizationId
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
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

  // Prefer the org-scoped list (it includes facilities the user administers but
  // holds no direct membership in); fall back to the /me facilities for that
  // org when the caller lacks org-admin scope on this endpoint.
  let facilities;
  try {
    facilities = (await api.get(`/org/${encodeURIComponent(context.orgId)}/facilities`)) ?? [];
  } catch {
    facilities = (getMe().facilities ?? []).filter((f) => f.organizationId === context.orgId);
  }

  setFacilities(facilities);
  clearChildren(select);
  select.append(el("option", { value: "" }, ["All facilities"]));
  for (const facility of facilities) {
    select.append(el("option", { value: facility.id }, [facility.name ?? facility.id]));
  }
  // Drop a remembered facility that isn't in this organization.
  const remembered = context.facilityId ?? "";
  const valid = facilities.some((facility) => facility.id === remembered);
  select.value = valid ? remembered : "";
  if (!valid && remembered) setContext({ facilityId: "" });
  select.disabled = facilities.length === 0;
}

// Populates the organization picker from /me and restores (or picks) the active
// organization. Replaces the old "paste an organization id" text field.
async function wireContextControls() {
  const orgSelect = document.getElementById("org-select");
  const facilitySelect = document.getElementById("facility-select");
  if (!orgSelect || !facilitySelect) return;

  const organizations = organizationsFromMe();
  clearChildren(orgSelect);

  if (organizations.length === 0) {
    orgSelect.append(el("option", { value: "" }, ["No organizations available"]));
    orgSelect.disabled = true;
    await refreshFacilitySelect();
    return;
  }

  for (const organization of organizations) {
    orgSelect.append(el("option", { value: organization.id }, [organization.name]));
  }

  // Keep the remembered organization when the user still has access to it,
  // otherwise fall back to their first one so the app is usable immediately.
  const remembered = getContext().orgId ?? "";
  const active = organizations.some((organization) => organization.id === remembered)
    ? remembered
    : organizations[0].id;
  orgSelect.value = active;
  orgSelect.disabled = false;
  if (active !== remembered) setContext({ orgId: active, facilityId: "" });

  orgSelect.addEventListener("change", () => {
    setContext({ orgId: orgSelect.value, facilityId: "" });
    refreshFacilitySelect();
  });

  facilitySelect.addEventListener("change", () => {
    setContext({ facilityId: facilitySelect.value });
  });

  await refreshFacilitySelect();
}

function wireUnpublishedBadge() {
  window.addEventListener("hashchange", () => refreshUnpublishedBadge());
  subscribe(() => refreshUnpublishedBadge());
  refreshUnpublishedBadge();
}

// The admin area is for signed-in users only. Bounce to /signin before doing any
// work when there is no stored session at all, and again if the API rejects the
// one we have (api.js has already tried a silent refresh by that point).
async function requireSession() {
  if (!hasToken()) {
    redirectToSignIn();
    return null;
  }
  const me = await loadMe();
  if (me.error === "missing-token" || me.error === "unauthorized") {
    redirectToSignIn();
    return null;
  }
  return me;
}

async function bootstrap() {
  wireSidebarToggle();
  wireSessionControl();

  const me = await requireSession();
  if (!me) return;

  await wireContextControls();
  wireUnpublishedBadge();
  initRouter();
}

bootstrap();
