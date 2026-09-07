import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildAdaptersFromEnv } from "../src/lib/notifications/adapters.mjs";
import { noopAdapter as noopEmailAdapter } from "../src/lib/notifications/email.mjs";
import { noopAdapter as noopPushAdapter } from "../src/lib/notifications/push.mjs";

function validFcmServiceAccountJson() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return Buffer.from(
    JSON.stringify({
      client_email: "worker@test-project.iam.gserviceaccount.com",
      private_key: privateKey,
      project_id: "test-project",
      token_uri: "https://oauth2.googleapis.com/token"
    })
  ).toString("base64");
}

test("buildAdaptersFromEnv defaults to the noop adapters when both providers are unset", () => {
  const { emailAdapter, pushAdapter } = buildAdaptersFromEnv({});
  assert.equal(emailAdapter, noopEmailAdapter);
  assert.equal(pushAdapter, noopPushAdapter);
});

test("buildAdaptersFromEnv defaults to the noop adapters when both providers are explicitly 'noop'", () => {
  const { emailAdapter, pushAdapter } = buildAdaptersFromEnv({ EMAIL_PROVIDER: "noop", PUSH_PROVIDER: "noop" });
  assert.equal(emailAdapter, noopEmailAdapter);
  assert.equal(pushAdapter, noopPushAdapter);
});

test("buildAdaptersFromEnv builds a real resend adapter when EMAIL_PROVIDER=resend with credentials", () => {
  const { emailAdapter } = buildAdaptersFromEnv({
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: "key",
    EMAIL_FROM: "noreply@example.com"
  });
  assert.notEqual(emailAdapter, noopEmailAdapter);
  assert.equal(typeof emailAdapter.send, "function");
});

test("buildAdaptersFromEnv throws when EMAIL_PROVIDER=resend is missing EMAIL_API_KEY", () => {
  assert.throws(
    () => buildAdaptersFromEnv({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "noreply@example.com" }),
    /EMAIL_API_KEY/
  );
});

test("buildAdaptersFromEnv throws when EMAIL_PROVIDER=resend is missing EMAIL_FROM", () => {
  assert.throws(() => buildAdaptersFromEnv({ EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "key" }), /EMAIL_FROM/);
});

test("buildAdaptersFromEnv throws on an unrecognized EMAIL_PROVIDER", () => {
  assert.throws(() => buildAdaptersFromEnv({ EMAIL_PROVIDER: "sendgrid" }), /Unknown EMAIL_PROVIDER/);
});

test("buildAdaptersFromEnv builds a real fcm adapter when PUSH_PROVIDER=fcm with a valid service account", () => {
  const { pushAdapter } = buildAdaptersFromEnv({
    PUSH_PROVIDER: "fcm",
    FCM_SERVICE_ACCOUNT_JSON: validFcmServiceAccountJson()
  });
  assert.notEqual(pushAdapter, noopPushAdapter);
  assert.equal(typeof pushAdapter.send, "function");
});

test("buildAdaptersFromEnv throws when PUSH_PROVIDER=fcm is missing FCM_SERVICE_ACCOUNT_JSON", () => {
  assert.throws(() => buildAdaptersFromEnv({ PUSH_PROVIDER: "fcm" }), /FCM_SERVICE_ACCOUNT_JSON/);
});

test("buildAdaptersFromEnv throws on an unrecognized PUSH_PROVIDER", () => {
  assert.throws(() => buildAdaptersFromEnv({ PUSH_PROVIDER: "apns" }), /Unknown PUSH_PROVIDER/);
});

test("buildAdaptersFromEnv throws (surfacing the malformed service account's own error) when PUSH_PROVIDER=fcm has invalid JSON", () => {
  assert.throws(
    () => buildAdaptersFromEnv({ PUSH_PROVIDER: "fcm", FCM_SERVICE_ACCOUNT_JSON: Buffer.from("not json").toString("base64") }),
    /valid JSON/
  );
});

test("buildAdaptersFromEnv is case-insensitive on provider names", () => {
  const { emailAdapter, pushAdapter } = buildAdaptersFromEnv({ EMAIL_PROVIDER: "NOOP", PUSH_PROVIDER: "NOOP" });
  assert.equal(emailAdapter, noopEmailAdapter);
  assert.equal(pushAdapter, noopPushAdapter);
});
