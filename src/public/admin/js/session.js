// Loads and caches the /me response (current user + the facilities they can
// act in), used by the nav (permission-based visibility), the top bar (signed-in
// identity), and the dashboard.

import { api, ApiError, hasToken } from "./api.js";
import { getMe, setMe } from "./state.js";

const SIGNED_OUT = { userId: null, email: null, facilities: [], platformAdmin: false };

let pending = null;

async function fetchMe() {
  if (!hasToken()) {
    setMe({ ...SIGNED_OUT, error: "missing-token" });
    return getMe();
  }
  try {
    // Shape comes from src/lib/http/me-route.mjs:
    //   { user: { id, email }, platformAdmin, facilities: [{ id, name, organizationId, permissions }] }
    const data = await api.get("/me");
    setMe({
      userId: data?.user?.id ?? null,
      email: data?.user?.email ?? null,
      facilities: Array.isArray(data?.facilities) ? data.facilities : [],
      platformAdmin: data?.platformAdmin === true,
      error: null
    });
  } catch (error) {
    const reason = error instanceof ApiError && error.status === 401 ? "unauthorized" : "error";
    setMe({ ...SIGNED_OUT, error: reason });
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
