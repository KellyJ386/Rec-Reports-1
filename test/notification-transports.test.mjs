import test from "node:test";
import assert from "node:assert/strict";
import { logTransport, webhookTransport, sendgridTransport, selectTransport } from "../src/lib/notifications/transports.mjs";

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const { ok = true, status = 202 } = respond ? respond(url, init) : {};
    return { ok, status, text: async () => "" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

const EMAIL_DELIVERY = {
  channel: "email",
  employeeId: "emp-1",
  target: "person@example.com",
  jobId: "job-1",
  facilityId: "fac-1",
  eventType: "incident.escalated"
};

test("logTransport reports success without network", async () => {
  const result = await logTransport.send(EMAIL_DELIVERY);
  assert.deepEqual(result, { ok: true });
});

test("sendgridTransport requires apiKey and from", () => {
  assert.throws(() => sendgridTransport({ from: "a@b.com" }), /apiKey/);
  assert.throws(() => sendgridTransport({ apiKey: "k" }), /from/);
});

test("sendgridTransport posts a Mail Send request for an email delivery", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true, status: 202 }));
  const transport = sendgridTransport({ apiKey: "sg-key", from: "noreply@rec.app" });
  const result = await transport.send(EMAIL_DELIVERY);
  assert.deepEqual(result, { ok: true });
  const call = captured[0];
  assert.equal(call.url, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(call.init.headers.Authorization, "Bearer sg-key");
  assert.equal(call.body.personalizations[0].to[0].email, "person@example.com");
  assert.equal(call.body.from.email, "noreply@rec.app");
  assert.match(call.body.subject, /incident\.escalated/);
});

test("sendgridTransport surfaces a non-2xx as an error (for retry)", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 429 }));
  const transport = sendgridTransport({ apiKey: "k", from: "a@b.com" });
  const result = await transport.send(EMAIL_DELIVERY);
  assert.equal(result.ok, false);
  assert.match(result.error, /429/);
});

test("sendgridTransport fails cleanly when an email delivery has no target", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true }));
  const transport = sendgridTransport({ apiKey: "k", from: "a@b.com" });
  const result = await transport.send({ ...EMAIL_DELIVERY, target: null });
  assert.equal(result.ok, false);
  assert.equal(captured.length, 0);
});

test("sendgridTransport logs non-email channels instead of emailing", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true }));
  const transport = sendgridTransport({ apiKey: "k", from: "a@b.com" });
  const result = await transport.send({ ...EMAIL_DELIVERY, channel: "in_app" });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.length, 0);
});

test("selectTransport maps names to transports and defaults to log", (t) => {
  stubFetch(t, () => ({ ok: true }));
  assert.equal(selectTransport("sendgrid", { sendgridApiKey: "k", fromEmail: "a@b.com" }).send.constructor.name, "AsyncFunction");
  assert.equal(selectTransport("webhook", { webhookUrl: "https://x" }).send.constructor.name, "AsyncFunction");
  assert.equal(selectTransport("nope"), logTransport);
  assert.equal(selectTransport(undefined), logTransport);
});

test("webhookTransport posts the delivery JSON", async (t) => {
  const captured = stubFetch(t, () => ({ ok: true, status: 200 }));
  const result = await webhookTransport("https://relay.example.com/hook").send(EMAIL_DELIVERY);
  assert.deepEqual(result, { ok: true });
  assert.equal(captured[0].url, "https://relay.example.com/hook");
  assert.equal(captured[0].body.eventType, "incident.escalated");
});
