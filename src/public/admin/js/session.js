// Loads and caches the /me response (current user + memberships), used by
// the nav (permission-based visibility) and the dashboard page.

import { api, ApiError, hasToken } from "./api.js";
import { getMe, setMe } from "./state.js";

let pending = null;

async function fetchMe() {
  if (!hasToken()) {
    setMe({ userId: null, memberships: [], platformAdmin: false, error: "missing-token" });
    return getMe();
  }
  try {
    const data = await api.get("/me");
    setMe({
      userId: data?.userId ?? null,
      memberships: data?.memberships ?? [],
      platformAdmin: data?.platformAdmin === true,
      error: null
    });
  } catch (error) {
    const reason = error instanceof ApiError && error.status === 401 ? "unauthorized" : "error";
    setMe({ userId: null, memberships: [], platformAdmin: false, error: reason });
  }
  return getMe();
}

export function loadMe({ force = false } = {}) {
  if (!force && getMe().loaded) return Promise.resolve(getMe());
  if (!pending) {
    pending = fetchMe().finally(() => {
      pending = null;
    });
  }
  return pending;
}
