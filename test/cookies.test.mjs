import test from "node:test";
import assert from "node:assert/strict";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_MAX_AGE,
  buildRefreshCookie,
  clearRefreshCookie,
  parseCookies
} from "../src/lib/http/cookies.mjs";

test("buildRefreshCookie: default (secure) attributes", () => {
  const cookie = buildRefreshCookie({ token: "tok-123" });
  const parts = cookie.split("; ");
  assert.equal(parts[0], `${REFRESH_COOKIE_NAME}=tok-123`);
  assert.ok(parts.includes("HttpOnly"));
  assert.ok(parts.includes("Secure"));
  assert.ok(parts.includes("SameSite=Strict"));
  assert.ok(parts.includes(`Path=${REFRESH_COOKIE_PATH}`));
  assert.ok(parts.includes(`Max-Age=${REFRESH_COOKIE_MAX_AGE}`));
});

test("buildRefreshCookie: secure=false omits the Secure attribute only", () => {
  const cookie = buildRefreshCookie({ token: "tok-123", secure: false });
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test("buildRefreshCookie: custom maxAge", () => {
  const cookie = buildRefreshCookie({ token: "tok-123", maxAge: 60 });
  assert.match(cookie, /Max-Age=60/);
});

test("clearRefreshCookie: empty value, Max-Age=0, matches the set cookie's other attributes", () => {
  const cookie = clearRefreshCookie({ secure: true });
  assert.match(cookie, /^rr_refresh=;/);
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, new RegExp(`Path=${REFRESH_COOKIE_PATH.replace("/", "\\/")}`));
});

test("clearRefreshCookie: secure=false omits Secure, defaults to secure=true", () => {
  assert.doesNotMatch(clearRefreshCookie({ secure: false }), /Secure/);
  assert.match(clearRefreshCookie(), /Secure/);
  assert.match(clearRefreshCookie({}), /Secure/);
});

test("parseCookies: parses a simple Cookie header", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
});

test("parseCookies: extracts rr_refresh among other cookies", () => {
  const cookies = parseCookies("theme=dark; rr_refresh=abc.def.ghi; other=x");
  assert.equal(cookies.rr_refresh, "abc.def.ghi");
});

test("parseCookies: missing/empty header returns {}", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(null), {});
  assert.deepEqual(parseCookies(""), {});
});

test("parseCookies: URI-decodes values, tolerating malformed percent-encoding", () => {
  const cookies = parseCookies("a=hello%20world; b=%zz");
  assert.equal(cookies.a, "hello world");
  // %zz is not valid percent-encoding -- decodeURIComponent throws, so the
  // raw value is kept rather than the whole header parse failing.
  assert.equal(cookies.b, "%zz");
});

test("parseCookies: ignores malformed pairs without an =", () => {
  assert.deepEqual(parseCookies("a=1; garbage; b=2"), { a: "1", b: "2" });
});

test("parseCookies: trims whitespace around names and values", () => {
  assert.deepEqual(parseCookies("  a = 1 ;  b=2"), { a: "1", b: "2" });
});
