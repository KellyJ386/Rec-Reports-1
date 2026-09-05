// Fetch wrapper for the /api/admin/v1 admin BFF. Reads the bearer token from
// the session established by the sign-in page (see auth.js) and attaches it to
// every request.
//
// A 401 is handled here rather than by each caller: the wrapper tries one silent
// refresh and replays the request, and only if that fails does it clear the
// session and send the browser to /signin. Callers still receive ApiError for
// every other failure status.

import {
  getToken,
  hasToken,
  clearSession,
  redirectToSignIn,
  refreshSession
} from "./auth.js";

const API_BASE = "/api/admin/v1";

export { getToken, hasToken };

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function send(method, path, body) {
  const token = getToken();
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new ApiError(`Network error contacting the admin API: ${error.message}`, 0, null);
  }
}

async function request(method, path, body) {
  let response = await send(method, path, body);

  if (response.status === 401 && (await refreshSession())) {
    response = await send(method, path, body);
  }

  if (response.status === 401) {
    // Refresh was impossible or also rejected: the session is over.
    clearSession();
    redirectToSignIn();
    throw new ApiError("Your session has expired. Please sign in again.", 401, null);
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
  patch: (path, body) => request("PATCH", path, body ?? {}),
  del: (path) => request("DELETE", path)
};
