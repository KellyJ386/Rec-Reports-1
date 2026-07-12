// Current org/facility context plus the cached /me response. Context is
// persisted to localStorage so a refresh keeps the admin on the same
// organization/facility. Subscribers are notified on any change so nav.js
// and the top bar can re-render without a page reload.

const CONTEXT_KEY = "rr_admin_context";

const listeners = new Set();

function loadContext() {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    if (!raw) return { orgId: "", facilityId: "" };
    const parsed = JSON.parse(raw);
    return {
      orgId: typeof parsed.orgId === "string" ? parsed.orgId : "",
      facilityId: typeof parsed.facilityId === "string" ? parsed.facilityId : ""
    };
  } catch {
    return { orgId: "", facilityId: "" };
  }
}

let context = loadContext();
let me = { userId: null, memberships: [], loaded: false, error: null };
let facilities = [];

function persistContext() {
  try {
    localStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
  } catch {
    // ignore storage failures
  }
}

function notify() {
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getContext() {
  return { ...context };
}

export function setContext(patch) {
  const next = { ...context, ...patch };
  if (next.orgId === context.orgId && next.facilityId === context.facilityId) return;
  context = next;
  persistContext();
  notify();
}

export function getMe() {
  return me;
}

export function setMe(next) {
  me = { ...me, ...next, loaded: true };
  notify();
}

export function getFacilities() {
  return facilities;
}

export function setFacilities(list) {
  facilities = Array.isArray(list) ? list : [];
  notify();
}

export function hasAdminAccess() {
  if (!me.loaded) return true; // optimistic while the initial /me call is in flight
  return me.memberships.some(
    (membership) => membership.status === "active" && (membership.permissions ?? []).includes("admin.manage")
  );
}

export function hasPermissionAnywhere(code) {
  if (!me.loaded) return true;
  return me.memberships.some(
    (membership) => membership.status === "active" && (membership.permissions ?? []).includes(code)
  );
}
