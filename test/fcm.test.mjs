import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createFcmAdapter } from "../src/lib/notifications/fcm.mjs";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const PROJECT_ID = "test-project-123";

function generateKeypair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function base64urlToJson(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return JSON.parse(Buffer.from(padded + "=".repeat(padLength), "base64").toString("utf8"));
}

function serviceAccountBase64({ privateKey, clientEmail = "worker@test-project.iam.gserviceaccount.com", projectId = PROJECT_ID, tokenUri = TOKEN_URI } = {}) {
  return Buffer.from(
    JSON.stringify({ client_email: clientEmail, private_key: privateKey, project_id: projectId, token_uri: tokenUri })
  ).toString("base64");
}

// Routes fetch calls between the token endpoint and the FCM send endpoint,
// recording every call so assertions can inspect exactly what was sent.
function fakeFetch({ tokenResponses = [], sendResponses = [] } = {}) {
  const calls = { token: [], send: [] };
  let tokenCallIndex = 0;
  let sendCallIndex = 0;
  const fetchImpl = async (url, init) => {
    if (url === TOKEN_URI) {
      calls.token.push({ url, init });
      const response = tokenResponses[Math.min(tokenCallIndex, tokenResponses.length - 1)];
      tokenCallIndex += 1;
      return { status: response.status, text: async () => JSON.stringify(response.body) };
    }
    calls.send.push({ url, init });
    const response = sendResponses[Math.min(sendCallIndex, sendResponses.length - 1)];
    sendCallIndex += 1;
    return { status: response.status, text: async () => JSON.stringify(response.body) };
  };
  return { fetchImpl, calls };
}

// --- decode + validation -------------------------------------------------

test("createFcmAdapter requires serviceAccountJson", () => {
  assert.throws(() => createFcmAdapter({}), /serviceAccountJson/);
});

test("createFcmAdapter throws (at construction, not send time) when the base64 payload is not valid JSON", () => {
  assert.throws(() => createFcmAdapter({ serviceAccountJson: Buffer.from("not json").toString("base64") }), /valid JSON/);
});

test("createFcmAdapter throws when required fields are missing", () => {
  const missingProjectId = Buffer.from(
    JSON.stringify({ client_email: "a@b.com", private_key: "pk", token_uri: TOKEN_URI })
  ).toString("base64");
  assert.throws(() => createFcmAdapter({ serviceAccountJson: missingProjectId }), /project_id/);
});

test("createFcmAdapter succeeds at construction with a fully-populated service account and makes no network call yet", () => {
  const { privateKey } = generateKeypair();
  assert.doesNotThrow(() => createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }) }));
});

// --- token minting request shape + RS256 signature ------------------------

test("createFcmAdapter mints an access token with a verifiable RS256-signed JWT assertion", async () => {
  const { publicKey, privateKey } = generateKeypair();
  const clientEmail = "worker@test-project.iam.gserviceaccount.com";
  const now = () => new Date("2026-09-01T00:00:00.000Z");
  const { fetchImpl, calls } = fakeFetch({
    tokenResponses: [{ status: 200, body: { access_token: "access-token-1", expires_in: 3600 } }],
    sendResponses: [{ status: 200, body: { name: "projects/x/messages/1" } }]
  });
  const adapter = createFcmAdapter({
    serviceAccountJson: serviceAccountBase64({ privateKey, clientEmail }),
    fetchImpl,
    now
  });

  await adapter.send({ tokens: ["dev-token-1"], title: "Hi", body: "There" });

  assert.equal(calls.token.length, 1);
  const tokenCall = calls.token[0];
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(tokenCall.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  const params = new URLSearchParams(tokenCall.init.body);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const assertion = params.get("assertion");
  assert.ok(assertion, "expected an assertion JWT in the token request body");

  const [headerSeg, claimsSeg, signatureSeg] = assertion.split(".");
  const header = base64urlToJson(headerSeg);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });

  const claims = base64urlToJson(claimsSeg);
  assert.equal(claims.iss, clientEmail);
  assert.equal(claims.aud, TOKEN_URI);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.iat, Math.floor(now().getTime() / 1000));
  assert.equal(claims.exp, claims.iat + 3600);

  // Verify the signature against the keypair's PUBLIC key -- proves the
  // assertion was actually signed with the service account's private key
  // via node:crypto createSign("RSA-SHA256"), not merely shaped like a JWT.
  const signingInput = `${headerSeg}.${claimsSeg}`;
  const signatureBuffer = Buffer.from(signatureSeg.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  assert.equal(verifier.verify(publicKey, signatureBuffer), true, "expected a valid RS256 signature over header.claims");
});

// --- caching + single-flight ----------------------------------------------

test("createFcmAdapter caches the access token across multiple tokens within one send() call (only one mint request)", async () => {
  const { privateKey } = generateKeypair();
  const { fetchImpl, calls } = fakeFetch({
    tokenResponses: [{ status: 200, body: { access_token: "access-token-1", expires_in: 3600 } }],
    sendResponses: [
      { status: 200, body: { name: "1" } },
      { status: 200, body: { name: "2" } },
      { status: 200, body: { name: "3" } }
    ]
  });
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl });

  await adapter.send({ tokens: ["t1", "t2", "t3"], title: "Hi", body: "There" });

  assert.equal(calls.token.length, 1);
  assert.equal(calls.send.length, 3);
  for (const call of calls.send) {
    assert.equal(call.init.headers.Authorization, "Bearer access-token-1");
  }
});

test("createFcmAdapter caches the access token across separate send() calls until it is near expiry", async () => {
  const { privateKey } = generateKeypair();
  let current = new Date("2026-09-01T00:00:00.000Z");
  const now = () => current;
  const { fetchImpl, calls } = fakeFetch({
    tokenResponses: [{ status: 200, body: { access_token: "access-token-1", expires_in: 3600 } }],
    sendResponses: [{ status: 200, body: { name: "1" } }]
  });
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl, now });

  await adapter.send({ tokens: ["t1"] });
  assert.equal(calls.token.length, 1);

  // 10 minutes later -- well inside the 1-hour token lifetime.
  current = new Date(current.getTime() + 10 * 60 * 1000);
  await adapter.send({ tokens: ["t1"] });
  assert.equal(calls.token.length, 1, "expected the cached token to be reused");
});

test("createFcmAdapter re-mints the access token once it is within 60s of expiry", async () => {
  const { privateKey } = generateKeypair();
  let current = new Date("2026-09-01T00:00:00.000Z");
  const now = () => current;
  const { fetchImpl, calls } = fakeFetch({
    tokenResponses: [
      { status: 200, body: { access_token: "access-token-1", expires_in: 3600 } },
      { status: 200, body: { access_token: "access-token-2", expires_in: 3600 } }
    ],
    sendResponses: [{ status: 200, body: { name: "1" } }]
  });
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl, now });

  await adapter.send({ tokens: ["t1"] });
  assert.equal(calls.token.length, 1);

  // 59 minutes 30s later -- inside the 60s expiry slack.
  current = new Date(current.getTime() + 59.5 * 60 * 1000);
  const results = await adapter.send({ tokens: ["t1"] });
  assert.equal(calls.token.length, 2, "expected a fresh mint once within the 60s expiry slack");
  assert.equal(calls.send[calls.send.length - 1].init.headers.Authorization, "Bearer access-token-2");
  assert.equal(results[0].code, "ok");
});

test("createFcmAdapter single-flights concurrent mint requests: two overlapping send() calls share one token POST", async () => {
  const { privateKey } = generateKeypair();
  let resolveToken;
  const tokenPromise = new Promise((resolve) => {
    resolveToken = resolve;
  });
  const tokenCalls = [];
  const sendCalls = [];
  const fetchImpl = async (url, init) => {
    if (url === TOKEN_URI) {
      tokenCalls.push(init);
      await tokenPromise;
      return { status: 200, text: async () => JSON.stringify({ access_token: "access-token-1", expires_in: 3600 }) };
    }
    sendCalls.push(init);
    return { status: 200, text: async () => JSON.stringify({ name: "1" }) };
  };
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl });

  const first = adapter.send({ tokens: ["t1"] });
  const second = adapter.send({ tokens: ["t2"] });
  // Give both send() calls a chance to reach the token-mint step before the
  // mint resolves, so both observe "no usable cached token yet".
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tokenCalls.length, 1, "expected only one in-flight token mint request");
  resolveToken();
  await Promise.all([first, second]);
  assert.equal(tokenCalls.length, 1);
});

// --- FCM send request shape + outcome mapping ------------------------------

test("createFcmAdapter POSTs to /v1/projects/{project_id}/messages:send with the notification/data payload", async () => {
  const { privateKey } = generateKeypair();
  const { fetchImpl, calls } = fakeFetch({
    tokenResponses: [{ status: 200, body: { access_token: "tok", expires_in: 3600 } }],
    sendResponses: [{ status: 200, body: { name: "1" } }]
  });
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey, projectId: "proj-abc" }), fetchImpl });

  await adapter.send({ tokens: ["device-token-1"], title: "Evacuate", body: "Now", data: { messageId: "msg-1", count: 3 } });

  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].url, "https://fcm.googleapis.com/v1/projects/proj-abc/messages:send");
  assert.equal(calls.send[0].init.method, "POST");
  assert.equal(calls.send[0].init.headers.Authorization, "Bearer tok");
  const body = JSON.parse(calls.send[0].init.body);
  assert.equal(body.message.token, "device-token-1");
  assert.deepEqual(body.message.notification, { title: "Evacuate", body: "Now" });
  // FCM v1 requires every data value to be a string.
  assert.deepEqual(body.message.data, { messageId: "msg-1", count: "3" });
});

async function outcomeFor(sendResponse) {
  const { privateKey } = generateKeypair();
  const { fetchImpl } = fakeFetch({
    tokenResponses: [{ status: 200, body: { access_token: "tok", expires_in: 3600 } }],
    sendResponses: [sendResponse]
  });
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl });
  const results = await adapter.send({ tokens: ["t1"] });
  return results[0].code;
}

test("createFcmAdapter maps a 2xx response to ok", async () => {
  assert.equal(await outcomeFor({ status: 200, body: { name: "1" } }), "ok");
});

test("createFcmAdapter maps an UNREGISTERED fcm errorCode to unregistered", async () => {
  const body = { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } };
  assert.equal(await outcomeFor({ status: 404, body }), "unregistered");
});

test("createFcmAdapter maps an INVALID_ARGUMENT fcm errorCode to invalid_token", async () => {
  const body = { error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] } };
  assert.equal(await outcomeFor({ status: 400, body }), "invalid_token");
});

test("createFcmAdapter maps QUOTA_EXCEEDED/429 to rate_limited", async () => {
  const body = { error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } };
  assert.equal(await outcomeFor({ status: 429, body }), "rate_limited");
});

test("createFcmAdapter maps a 5xx response to server_error", async () => {
  assert.equal(await outcomeFor({ status: 500, body: { error: { status: "INTERNAL" } } }), "server_error");
});

test("createFcmAdapter maps a rejecting fetchImpl on the send call to timeout", async () => {
  const { privateKey } = generateKeypair();
  const fetchImpl = async (url) => {
    if (url === TOKEN_URI) {
      return { status: 200, text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }) };
    }
    throw new Error("network error");
  };
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl });
  const results = await adapter.send({ tokens: ["t1"] });
  assert.equal(results[0].code, "timeout");
});

test("createFcmAdapter resolves multiple tokens in one send() call, one result per token", async () => {
  const { privateKey } = generateKeypair();
  const { fetchImpl, calls } = fakeFetch({
    tokenResponses: [{ status: 200, body: { access_token: "tok", expires_in: 3600 } }],
    sendResponses: [
      { status: 200, body: { name: "1" } },
      { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } }
    ]
  });
  const adapter = createFcmAdapter({ serviceAccountJson: serviceAccountBase64({ privateKey }), fetchImpl });
  const results = await adapter.send({ tokens: ["good-token", "dead-token"] });
  assert.equal(calls.send.length, 2);
  assert.deepEqual(
    results.map((r) => r.token),
    ["good-token", "dead-token"]
  );
  assert.equal(results[0].code, "ok");
  assert.equal(results[1].code, "unregistered");
});
