// Browser-side session handling for the admin control center.
//
// The sign-in page (/signin/) POSTs credentials to the same-origin auth proxy
// in src/lib/http/auth-routes.mjs and stores the resulting Supabase session
// here. This module owns those storage keys, the silent refresh, and the
// redirects, so api.js and app.js never touch localStorage directly.

const TOKEN_KEY = "rr_admin_token";
const REFRESH_TOKEN_KEY = "rr_refresh_token";
const AUTH_BASE = "/api/v1/auth";
const SIGN_IN_PATH = "/signin/";

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    // Storage may be unavailable (private browsing, blocked cookies). Treat it
    // as "no session" rather than throwing out of every API call.
    return "";
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Session simply won't persist across reloads when storage is unavailable.
  }
}

export function getToken() {
  return readStorage(TOKEN_KEY);
}

export function getRefreshToken() {
  return readStorage(REFRESH_TOKEN_KEY);
}

export function hasToken() {
  return getToken().length > 0;
}

export function setSession(session) {
  writeStorage(TOKEN_KEY, session?.access_token ?? "");
  if (session?.refresh_token) writeStorage(REFRESH_TOKEN_KEY, session.refresh_token);
}

export function clearSession() {
  writeStorage(TOKEN_KEY, "");
  writeStorage(REFRESH_TOKEN_KEY, "");
}

// Sends the browser to the sign-in page, remembering where it was so sign-in
// can return it to the same admin page (including the #/hash route).
export function redirectToSignIn() {
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`${SIGN_IN_PATH}?next=${encodeURIComponent(here)}`);
}

// Single-flight refresh: several API calls can 401 at once when an access token
// expires, and they must not each burn the (single-use) refresh token. The first
// caller performs the exchange; the rest await the same promise.
let refreshInFlight = null;

async function exchangeRefreshToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  let response;
  try {
    response = await fetch(`${AUTH_BASE}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
  } catch {
    // Network failure: keep the stored session so a later call can retry
    // instead of signing the user out over a dropped connection.
    return false;
  }
  if (!response.ok) {
    // The refresh token itself is rejected — the session is genuinely over.
    clearSession();
    return false;
  }
  let session;
  try {
    session = await response.json();
  } catch {
    return false;
  }
  if (!session?.access_token) return false;
  setSession(session);
  return true;
}

export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = exchangeRefreshToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Best-effort revocation of the refresh token upstream, then a local clear and
// a bounce to the sign-in page. The local clear runs even if revocation fails,
// so "Sign out" always signs the browser out.
export async function signOut() {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${AUTH_BASE}/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      });
    } catch {
      // Ignore: revocation is a courtesy, the local clear below is what matters.
    }
  }
  clearSession();
  window.location.assign(SIGN_IN_PATH);
}
