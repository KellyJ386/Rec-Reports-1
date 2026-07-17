// Fetch wrapper for the /api/admin/v1 admin BFF. Reads the bearer token from
// localStorage (set by the /login/ page, or via the top-bar session token
// debug drawer) and attaches it to every request. On a 401 it attempts one
// silent refresh against Supabase Auth using the stored refresh token and
// retries once; if the refresh fails it signs out and redirects to /login/.

const TOKEN_KEY = "rr_admin_token";
const REFRESH_KEY = "rr_admin_refresh";
const API_BASE = "/api/admin/v1";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be unavailable (private browsing, quota); token simply
    // won't persist across reloads in that case.
  }
}

export function hasToken() {
  return getToken().length > 0;
}

export function getRefreshToken() {
  try {
    return localStorage.getItem(REFRESH_KEY) || "";
  } catch {
    return "";
  }
}

export function setRefreshToken(token) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    // Storage unavailable; refresh simply won't survive a reload.
  }
}

// Clears both tokens and returns to the sign-in page.
export function signOut() {
  setToken("");
  setRefreshToken("");
  window.location.href = "/login/";
}

async function attemptRefresh() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const configResponse = await fetch(`${API_BASE}/config`, {
      headers: { Accept: "application/json" }
    });
    if (!configResponse.ok) return false;
    const config = await configResponse.json();
    if (!config?.supabaseUrl || !config?.supabaseAnonKey) return false;
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.supabaseAnonKey },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!response.ok) return false;
    const data = await response.json();
    if (!data?.access_token) return false;
    setToken(data.access_token);
    if (data.refresh_token) setRefreshToken(data.refresh_token);
    return true;
  } catch {
    return false;
  }
}

// Single-flight refresh: concurrent 401s share one refresh attempt instead of
// racing (Supabase refresh tokens rotate, so a lost race would sign us out).
let refreshPending = null;
function refreshSession() {
  if (!refreshPending) {
    refreshPending = attemptRefresh().finally(() => {
      refreshPending = null;
    });
  }
  return refreshPending;
}

async function request(method, path, body, hasRetried = false) {
  const token = getToken();
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new ApiError(`Network error contacting the admin API: ${error.message}`, 0, null);
  }

  if (response.status === 401 && !hasRetried) {
    const refreshed = await refreshSession();
    if (refreshed) return request(method, path, body, true);
    signOut();
    throw new ApiError("Session expired; redirecting to sign in.", 401, null);
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

  if (!response.ok) {
    const message =
      (data && (data.error || (Array.isArray(data.errors) && data.errors.join(", ")))) ||
      `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, data);
  }

  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  put: (path, body) => request("PUT", path, body ?? {}),
  patch: (path, body) => request("PATCH", path, body ?? {})
};
