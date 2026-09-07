// FCM HTTP v1 push adapter (P-5, CM-07): implements push.mjs's adapter
// contract -- `async send({ tokens, title, body, data, fetchImpl }) ->
// [{ token, code }, ...]` -- against Google's real Firebase Cloud Messaging
// HTTP v1 API, using only node:crypto (no dependency, no googleapis SDK).
//
// FCM v1 authenticates with a short-lived Google OAuth2 access token minted
// from a service account, NOT a static server key (that was the deprecated
// "legacy HTTP" API's model). Minting one means:
//   1. Build a signed JWT ("assertion"): header {alg:"RS256",typ:"JWT"},
//      claims {iss: client_email, scope, aud: token_uri, iat, exp}, signed
//      with the service account's RSA private key via
//      node:crypto createSign("RSA-SHA256") -- see buildAssertion below.
//   2. POST that assertion to the service account's own token_uri
//      (grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer) to get back
//      { access_token, expires_in }.
//   3. Use `Authorization: Bearer <access_token>` on every
//      POST /v1/projects/{project_id}/messages:send call until the token is
//      about to expire.
//
// The access token is cached across calls (module-instance-scoped: one
// createFcmAdapter() call = one cache) until ~60s before its stated expiry,
// and minting is single-flighted -- concurrent send() calls that all find no
// usable cached token share ONE in-flight mint request rather than each
// firing their own, which both respects Google's token-endpoint rate limits
// and means multiple tokens in a single send() call after the very first
// mint never re-mint at all.
import { createSign } from "node:crypto";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUIRED_SERVICE_ACCOUNT_FIELDS = ["client_email", "private_key", "project_id", "token_uri"];
const DEFAULT_TIMEOUT_MS = 10000;
const TOKEN_EXPIRY_SLACK_MS = 60 * 1000;
const JWT_LIFETIME_SECONDS = 3600;

// Decodes and validates FCM_SERVICE_ACCOUNT_JSON (base64-encoded, since the
// raw Google service-account JSON embeds a multi-line PEM private key --
// base64 keeps it a single, env-var-safe line) at ADAPTER CONSTRUCTION time,
// never at send time: a misconfigured/missing service account should fail
// loudly the moment the adapter is built (see adapters.mjs's
// buildAdaptersFromEnv), not silently on the first real push attempt.
function decodeServiceAccount(serviceAccountJson) {
  if (!serviceAccountJson) {
    throw new Error("createFcmAdapter requires serviceAccountJson (base64-encoded FCM_SERVICE_ACCOUNT_JSON)");
  }
  const decoded = Buffer.from(String(serviceAccountJson), "base64").toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(
      `createFcmAdapter: FCM_SERVICE_ACCOUNT_JSON did not base64-decode to valid JSON (${error.message})`
    );
  }
  const missing = REQUIRED_SERVICE_ACCOUNT_FIELDS.filter((field) => !parsed?.[field]);
  if (missing.length > 0) {
    throw new Error(
      `createFcmAdapter: service account JSON is missing required field(s): ${missing.join(", ")}`
    );
  }
  return parsed;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds and RS256-signs the OAuth2 assertion JWT described in the file
// header. `now` is injectable (tests pin it) so the minted `exp` claim is
// deterministic.
function buildAssertion({ clientEmail, privateKey, tokenUri, now }) {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + JWT_LIFETIME_SECONDS;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: clientEmail, scope: FCM_SCOPE, aud: tokenUri, iat, exp };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${signature}`;
}

// Mirrors src/lib/observability.mjs's timeoutRejection/postWithTimeout pair
// -- see that file's comment for why the AbortController alone is not
// enough (a fetchImpl, real or stubbed, that ignores the signal must still
// not hang this call past timeoutMs).
function timeoutRejection(ms) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("FCM request timed out")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function postWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const { promise: timesOut, cancel: cancelTimeout } = timeoutRejection(timeoutMs);
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timesOut]);
  } finally {
    clearTimeout(abortTimer);
    cancelTimeout();
  }
}

async function readJsonBody(response) {
  try {
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Maps an FCM v1 send response to one of push.mjs's provider-agnostic
// outcome codes (see push.mjs's PROVIDER_OUTCOMES -- this file never
// reimplements sent/retryable/permanent classification, only produces the
// `code` push.mjs's classifyOutcome already knows how to read).
//
// FCM v1 errors are shaped as Google's standard { error: { status, details:
// [...] } } (google.rpc.Status): a machine-readable `status` string
// (INVALID_ARGUMENT, NOT_FOUND, RESOURCE_EXHAUSTED, UNAVAILABLE, INTERNAL,
// ...) plus, for FCM-specific rejections, a details entry carrying its own
// `errorCode` (UNREGISTERED, INVALID_ARGUMENT, SENDER_ID_MISMATCH, ...) --
// the FCM-specific errorCode is checked first since it is the more precise
// signal when present.
function classifySendResponse(httpStatus, body) {
  if (httpStatus >= 200 && httpStatus < 300) return "ok";

  const fcmDetail = (body?.error?.details ?? []).find((detail) => typeof detail?.errorCode === "string");
  const fcmErrorCode = fcmDetail?.errorCode;
  if (fcmErrorCode === "UNREGISTERED") return "unregistered";
  if (fcmErrorCode === "INVALID_ARGUMENT") return "invalid_token";
  if (fcmErrorCode === "SENDER_ID_MISMATCH") return "mismatched_sender";

  const rpcStatus = body?.error?.status;
  if (httpStatus === 429 || rpcStatus === "RESOURCE_EXHAUSTED") return "rate_limited";
  if (httpStatus === 404 || rpcStatus === "NOT_FOUND") return "unregistered";
  if (httpStatus === 400 || rpcStatus === "INVALID_ARGUMENT") return "invalid_token";
  if (httpStatus >= 500 || rpcStatus === "UNAVAILABLE" || rpcStatus === "INTERNAL") return "server_error";
  return "server_error";
}

// FCM v1 requires every `data` value to be a string.
function stringifyData(data) {
  const entries = Object.entries(data ?? {}).map(([key, value]) => [key, String(value)]);
  return Object.fromEntries(entries);
}

export function createFcmAdapter({
  serviceAccountJson,
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const account = decodeServiceAccount(serviceAccountJson);

  // Instance-scoped token cache + single-flight mint (see file header).
  let cachedToken = null; // { accessToken, expiresAt }
  let inFlightMint = null;

  async function getAccessToken(effectiveFetch) {
    const nowDate = now();
    if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_SLACK_MS > nowDate.getTime()) {
      return cachedToken.accessToken;
    }
    if (!inFlightMint) {
      inFlightMint = (async () => {
        const assertion = buildAssertion({
          clientEmail: account.client_email,
          privateKey: account.private_key,
          tokenUri: account.token_uri,
          now: nowDate
        });
        const body = new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion
        });
        const response = await postWithTimeout(
          effectiveFetch,
          account.token_uri,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
          },
          timeoutMs
        );
        const parsed = await readJsonBody(response);
        if (!(response.status >= 200 && response.status < 300) || !parsed?.access_token) {
          throw new Error(`FCM token mint failed with status ${response.status}`);
        }
        const expiresInMs = (Number(parsed.expires_in) || JWT_LIFETIME_SECONDS) * 1000;
        cachedToken = { accessToken: parsed.access_token, expiresAt: nowDate.getTime() + expiresInMs };
        return cachedToken.accessToken;
      })();
    }
    try {
      return await inFlightMint;
    } finally {
      inFlightMint = null;
    }
  }

  async function sendOne({ token, title, body, data, effectiveFetch }) {
    let accessToken;
    try {
      accessToken = await getAccessToken(effectiveFetch);
    } catch {
      // Can't even authenticate -- not this token's fault, so it's a
      // transient/server-side problem, never a reason to revoke the token.
      return { token, code: "server_error" };
    }

    let response;
    try {
      response = await postWithTimeout(
        effectiveFetch,
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: { token, notification: { title, body }, data: stringifyData(data) }
          })
        },
        timeoutMs
      );
    } catch {
      return { token, code: "timeout" };
    }

    const parsedBody = await readJsonBody(response);
    return { token, code: classifySendResponse(response.status, parsedBody) };
  }

  return {
    async send({ tokens = [], title, body, data = {}, fetchImpl: callFetch } = {}) {
      const effectiveFetch = callFetch ?? fetchImpl;
      const results = [];
      for (const token of tokens) {
        results.push(await sendOne({ token, title, body, data, effectiveFetch }));
      }
      return results;
    }
  };
}
