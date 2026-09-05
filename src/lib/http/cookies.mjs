// Pure helpers for the refresh-token cookie (S-11). No request/response
// objects here on purpose -- callers (auth-routes.mjs) decide `secure` from
// the request and hand the string to `response.setHeader("Set-Cookie", …)`
// themselves, which keeps these functions trivial to unit test.

export const REFRESH_COOKIE_NAME = "rr_refresh";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
// 30 days, matching GoTrue's default refresh-token lifetime expectations.
export const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// Builds the Set-Cookie value that hands the browser a fresh refresh token.
// `secure` is the caller's own http-vs-https determination (see
// `isSecureRequest` in auth-routes.mjs) -- omitted only for plain-http
// localhost so local dev over `http://localhost` still works; every other
// origin gets `Secure`. `maxAge` is seconds, matching the `Max-Age` cookie
// attribute's own unit.
export function buildRefreshCookie({ token, secure = true, maxAge = REFRESH_COOKIE_MAX_AGE }) {
  const attributes = [
    `${REFRESH_COOKIE_NAME}=${token}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
    `Path=${REFRESH_COOKIE_PATH}`,
    `Max-Age=${maxAge}`
  ];
  return attributes.join("; ");
}

// Same attributes with an empty value and Max-Age=0 -- the standard way to
// tell the browser to drop a cookie immediately. Attributes (Path, SameSite,
// HttpOnly, Secure) must match the cookie that was set, or the browser
// treats this as a *different* cookie and the original lingers.
export function clearRefreshCookie({ secure = true } = {}) {
  return buildRefreshCookie({ token: "", secure, maxAge: 0 });
}

// Tiny `Cookie` request-header parser: `"a=1; b=2"` -> `{ a: "1", b: "2" }`.
// Not a general-purpose cookie parser (no quoted-value or attribute
// handling -- there are no attributes on the request side) -- just enough
// to pull `rr_refresh` back out. Empty/missing header -> `{}`.
export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of String(header).split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}
