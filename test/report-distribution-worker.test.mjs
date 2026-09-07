import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { processReportSubmittedEvents } from "../src/lib/report-distribution.mjs";

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

// Same fixed clock convention as test/notifications-worker.test.mjs.
const NOON = new Date("2026-09-07T15:00:00.000Z"); // clear of the default 22:00-06:00 quiet window
const QUIET = new Date("2026-09-07T23:00:00.000Z"); // inside it

function outboxEvent(overrides = {}) {
  return {
    id: "outbox-1",
    facility_id: "fac-1",
    event_type: "report.submitted",
    payload: { submission_id: "sub-1", template_id: "tpl-1", facility_id: "fac-1" },
    status: "pending",
    attempts: 0,
    available_at: "2026-09-07T14:00:00.000Z",
    processed_at: null,
    last_error: null,
    next_attempt_at: null,
    created_at: "2026-09-07T14:00:00.000Z",
    ...overrides
  };
}

function submissionFixture(overrides = {}) {
  return {
    id: "sub-1",
    facility_id: "fac-1",
    department_id: null,
    template_id: "tpl-1",
    report_date: "2026-09-07",
    shift_ref: null,
    status: "submitted",
    pdf_status: "not_requested",
    ...overrides
  };
}

function bindingFixture(overrides = {}) {
  return {
    id: "bind-1",
    facility_id: "fac-1",
    template_id: "tpl-1",
    distribution_list_id: "list-1",
    department_id: null,
    role_id: null,
    channel: "email",
    attach_pdf: false,
    digest: false,
    active: true,
    ...overrides
  };
}

function templateFixture(overrides = {}) {
  return { id: "tpl-1", facility_id: "fac-1", name: "Shift Handoff", code: "shift", ...overrides };
}

function employeeFixture(overrides = {}) {
  return { id: "emp-1", facility_id: "fac-1", department_id: null, user_id: "user-1", ...overrides };
}

function appUserFixture(overrides = {}) {
  return { id: "user-1", email: "emp1@test.example", ...overrides };
}

function memberFixture(overrides = {}) {
  return { id: "m-1", facility_id: "fac-1", distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1", ...overrides };
}

function eqParam(url, key) {
  const v = url.searchParams.get(key);
  if (v === null) return null;
  return v.startsWith("eq.") ? v.slice(3) : v;
}

// A stateful in-memory PostgREST double: enough of outbox_events/
// report_submissions/report_distribution_lists/report_templates/
// distribution_list_members/employees/memberships/app_users/
// report_deliveries/notification_jobs round-tripping for
// processReportSubmittedEvents to run its real logic against, including
// INSERT/PATCH id echo so a second phase (e.g. finalizeEvent) sees the
// state a prior phase (e.g. attachDeliveryRows) actually wrote.
function makeStore({
  outbox = [],
  submissions = [],
  bindings = [],
  templates = [],
  members = [],
  employees = [],
  memberships = [],
  appUsers = [],
  deliveries = []
} = {}) {
  const state = {
    outbox: new Map(outbox.map((o) => [o.id, { ...o }])),
    submissions,
    bindings,
    templates,
    members,
    employees,
    memberships,
    appUsers,
    deliveries: new Map(deliveries.map((d) => [d.id, { ...d }])),
    notificationJobs: []
  };
  let deliveryCounter = 0;
  let jobCounter = 0;
  const captured = [];

  function respond(table, method, url, body) {
    captured.push({ table, method, url, body });

    if (table === "outbox_events") {
      if (method === "GET") return [...state.outbox.values()].filter((o) => o.status === "pending");
      if (method === "PATCH") {
        const id = eqParam(url, "id");
        const existing = state.outbox.get(id);
        if (!existing) return [];
        const statusFilter = eqParam(url, "status");
        if (statusFilter && existing.status !== statusFilter) return [];
        const updated = { ...existing, ...body };
        state.outbox.set(id, updated);
        return [updated];
      }
    }
    if (table === "report_submissions" && method === "GET") {
      const id = eqParam(url, "id");
      return state.submissions.filter((s) => !id || s.id === id);
    }
    if (table === "report_distribution_lists" && method === "GET") {
      const templateId = eqParam(url, "template_id");
      return state.bindings.filter((b) => !templateId || b.template_id === templateId);
    }
    if (table === "report_templates" && method === "GET") {
      const id = eqParam(url, "id");
      return state.templates.filter((t) => !id || t.id === id);
    }
    if (table === "distribution_list_members" && method === "GET") return state.members;
    if (table === "employees" && method === "GET") return state.employees;
    if (table === "memberships" && method === "GET") return state.memberships;
    if (table === "app_users" && method === "GET") return state.appUsers;
    if (table === "report_deliveries") {
      if (method === "GET") return [...state.deliveries.values()];
      if (method === "POST") {
        return body.map((row) => {
          deliveryCounter += 1;
          const id = `del-${deliveryCounter}`;
          const full = { id, provider_message_id: null, last_error: null, sent_at: null, ...row };
          state.deliveries.set(id, full);
          return full;
        });
      }
      if (method === "PATCH") {
        const id = eqParam(url, "id");
        const existing = state.deliveries.get(id);
        if (!existing) return [];
        const updated = { ...existing, ...body };
        state.deliveries.set(id, updated);
        return [updated];
      }
    }
    if (table === "notification_jobs" && method === "POST") {
      return body.map((row) => {
        jobCounter += 1;
        const full = { id: `job-${jobCounter}`, ...row };
        state.notificationJobs.push(full);
        return full;
      });
    }
    return [];
  }

  return { state, respond, captured };
}

function stubFetch(t, respond) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    const data = respond(table, method, parsed, body) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

function fakeEmailAdapter(code = "ok", providerMessageId = "provider-1") {
  const calls = [];
  return {
    calls,
    async send({ to, subject, text }) {
      calls.push({ to, subject, text });
      return { code, providerMessageId };
    }
  };
}

test("processReportSubmittedEvents sends an immediate email, writes a report_deliveries row, and persists the provider id", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [bindingFixture({ channel: "email", attach_pdf: false })],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);

  const adapter = fakeEmailAdapter("ok", "provider-msg-1");
  const summary = await processReportSubmittedEvents({
    client: client(),
    now: NOON,
    adapters: { email: adapter },
    config: { appUrl: "https://app.test" }
  });

  assert.deepEqual(summary, { claimed: 1, processed: 1, skipped: 0, retried: 0, failed: 0, rescheduled: 0 });
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].to, "emp1@test.example");
  assert.match(adapter.calls[0].subject, /Shift Handoff/);
  assert.match(adapter.calls[0].text, /https:\/\/app\.test\/reports\/sub-1/);

  const delivery = [...store.state.deliveries.values()][0];
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.provider_message_id, "provider-msg-1");
  assert.equal(delivery.channel, "email");
  assert.equal(delivery.submission_id, "sub-1");
  assert.equal(delivery.recipient_employee_id, "emp-1");

  const outboxRow = store.state.outbox.get("outbox-1");
  assert.equal(outboxRow.status, "processed");
});

test("attach_pdf includes a PDF link when pdf_status is generated, otherwise a will-follow note", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture({ pdf_status: "generated" })],
    bindings: [bindingFixture({ attach_pdf: true })],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter();
  await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter }, config: { appUrl: "https://app.test" } });
  assert.match(adapter.calls[0].text, /PDF: https:\/\/app\.test\/reports\/sub-1\/pdf/);
});

test("processReportSubmittedEvents defers the whole batch during quiet hours without touching deliveries", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [bindingFixture()],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter();

  const summary = await processReportSubmittedEvents({ client: client(), now: QUIET, adapters: { email: adapter } });
  assert.deepEqual(summary, { claimed: 1, processed: 0, skipped: 0, retried: 0, failed: 0, rescheduled: 1 });
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.state.deliveries.size, 0);

  const outboxRow = store.state.outbox.get("outbox-1");
  assert.equal(outboxRow.status, "pending");
  assert.ok(outboxRow.next_attempt_at);
  // Never even looked past the outbox claim -- no report_submissions query.
  assert.ok(!store.captured.some((c) => c.table === "report_submissions"));
});

test("digest bindings batch every submission resolved to the same recipient in one drain pass into ONE email", async (t) => {
  const store = makeStore({
    outbox: [
      outboxEvent({ id: "outbox-1", payload: { submission_id: "sub-1", template_id: "tpl-1", facility_id: "fac-1" } }),
      outboxEvent({ id: "outbox-2", payload: { submission_id: "sub-2", template_id: "tpl-1", facility_id: "fac-1" } })
    ],
    submissions: [submissionFixture({ id: "sub-1", report_date: "2026-09-06" }), submissionFixture({ id: "sub-2", report_date: "2026-09-07" })],
    bindings: [bindingFixture({ digest: true })],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter("ok", "digest-msg-1");

  const summary = await processReportSubmittedEvents({
    client: client(),
    now: NOON,
    adapters: { email: adapter },
    config: { appUrl: "https://app.test" }
  });

  assert.equal(summary.claimed, 2);
  assert.equal(summary.processed, 2);
  assert.equal(adapter.calls.length, 1, "both submissions must batch into a single digest email");
  assert.match(adapter.calls[0].subject, /2 submissions/);
  assert.match(adapter.calls[0].text, /2026-09-06/);
  assert.match(adapter.calls[0].text, /2026-09-07/);

  const deliveries = [...store.state.deliveries.values()];
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every((d) => d.status === "sent" && d.provider_message_id === "digest-msg-1"));
});

test("a retryable email outcome leaves the delivery 'failed' and the outbox event pending with attempts+1/backoff", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent({ attempts: 0 })],
    submissions: [submissionFixture()],
    bindings: [bindingFixture()],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter("server_error");

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter } });
  assert.deepEqual(summary, { claimed: 1, processed: 0, skipped: 0, retried: 1, failed: 0, rescheduled: 0 });

  const delivery = [...store.state.deliveries.values()][0];
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.attempts, 1);

  const outboxRow = store.state.outbox.get("outbox-1");
  assert.equal(outboxRow.status, "pending");
  assert.equal(outboxRow.attempts, 1);
  const backoffAt = new Date(NOON.getTime() + 2 * 60 * 1000).toISOString();
  assert.equal(outboxRow.next_attempt_at, backoffAt);
  // L-4 (security review): claimDueReportSubmittedEvents claims on
  // `available_at.lte.now OR next_attempt_at.lte.now` -- available_at must
  // ALSO be pushed to the backoff time on a retry, or the OR's available_at
  // half (still <= now from the original insert) would make the very next
  // drain pass re-claim the row immediately, defeating the backoff entirely.
  assert.equal(outboxRow.available_at, backoffAt);
});

test("a retry re-attempts only the outstanding leg, never re-sending an already-sent one (idempotent via the existing delivery row)", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent({ attempts: 1 })],
    submissions: [submissionFixture()],
    bindings: [bindingFixture()],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()],
    // Simulates a prior partial success: this leg already sent.
    deliveries: [
      {
        id: "del-existing",
        facility_id: "fac-1",
        submission_id: "sub-1",
        report_distribution_list_id: "bind-1",
        recipient_employee_id: "emp-1",
        channel: "email",
        status: "sent",
        provider_message_id: "already-sent",
        attempts: 1,
        last_error: null
      }
    ]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter("ok", "should-not-be-used");

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter } });
  assert.equal(adapter.calls.length, 0, "already-terminal leg must not be re-sent");
  assert.deepEqual(summary, { claimed: 1, processed: 1, skipped: 0, retried: 0, failed: 0, rescheduled: 0 });
  assert.equal(store.state.deliveries.get("del-existing").provider_message_id, "already-sent");
});

// L-9 (security review): attachDeliveryRows used to pair each freshly
// INSERTed report_deliveries row back to its originating leg by ARRAY
// INDEX, not by the natural (submission_id, report_distribution_list_id,
// recipient_employee_id, channel) key. Two recipients, a reversed insert
// response (simulating a provider that does not preserve request order),
// and two DIFFERENT outcomes per recipient -- if pairing were still by
// index, the outcomes would land on the wrong rows.
test("attachDeliveryRows pairs inserted rows to the correct recipient even when the insert response is reordered", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [bindingFixture()],
    templates: [templateFixture()],
    members: [
      memberFixture({ id: "m-1", member_ref_id: "emp-1" }),
      memberFixture({ id: "m-2", member_ref_id: "emp-2" })
    ],
    employees: [employeeFixture({ id: "emp-1", user_id: "user-1" }), employeeFixture({ id: "emp-2", user_id: "user-2" })],
    appUsers: [appUserFixture({ id: "user-1", email: "emp1@test.example" }), appUserFixture({ id: "user-2", email: "emp2@test.example" })]
  });
  // Wrap the store's respond so ONLY the report_deliveries INSERT response
  // comes back in REVERSED order relative to the request body -- everything
  // else behaves exactly like the shared store.
  const reorderedRespond = (table, method, url, body) => {
    const result = store.respond(table, method, url, body);
    if (table === "report_deliveries" && method === "POST" && Array.isArray(result)) {
      return [...result].reverse();
    }
    return result;
  };
  stubFetch(t, reorderedRespond);

  // A per-recipient outcome: emp1's address succeeds, emp2's is a
  // retryable failure -- if the two rows were mis-paired by index, emp1's
  // delivery row would end up 'failed' and emp2's 'sent' (swapped).
  const adapter = {
    async send({ to }) {
      return to === "emp1@test.example"
        ? { code: "ok", providerMessageId: "msg-emp1" }
        : { code: "server_error", providerMessageId: null };
    }
  };

  await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter } });

  const deliveries = [...store.state.deliveries.values()];
  assert.equal(deliveries.length, 2);
  const emp1Delivery = deliveries.find((d) => d.recipient_employee_id === "emp-1");
  const emp2Delivery = deliveries.find((d) => d.recipient_employee_id === "emp-2");
  assert.ok(emp1Delivery && emp2Delivery);
  assert.equal(emp1Delivery.status, "sent");
  assert.equal(emp1Delivery.provider_message_id, "msg-emp1");
  assert.equal(emp2Delivery.status, "failed");
});

test("a permanent provider rejection marks the delivery 'bounced' (terminal, no further retry)", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [bindingFixture()],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter("invalid_recipient");

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter } });
  assert.deepEqual(summary, { claimed: 1, processed: 1, skipped: 0, retried: 0, failed: 0, rescheduled: 0 });
  const delivery = [...store.state.deliveries.values()][0];
  assert.equal(delivery.status, "bounced");
});

test("in_app/push bindings hand off to notification_jobs instead of the email adapter", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [bindingFixture({ channel: "in_app" })],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture()],
    appUsers: [appUserFixture()]
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter();

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter } });
  assert.deepEqual(summary, { claimed: 1, processed: 1, skipped: 0, retried: 0, failed: 0, rescheduled: 0 });
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.state.notificationJobs.length, 1);
  assert.deepEqual(store.state.notificationJobs[0].payload_jsonb.recipients, ["emp-1"]);
  assert.deepEqual(store.state.notificationJobs[0].payload_jsonb.channels, ["in_app"]);
  const delivery = [...store.state.deliveries.values()][0];
  assert.equal(delivery.status, "sent");
});

test("an employee with no linked app_users email is skipped (terminal), never attempted", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [bindingFixture()],
    templates: [templateFixture()],
    members: [memberFixture()],
    employees: [employeeFixture({ user_id: null })],
    appUsers: []
  });
  stubFetch(t, store.respond);
  const adapter = fakeEmailAdapter();

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON, adapters: { email: adapter } });
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(summary, { claimed: 1, processed: 1, skipped: 0, retried: 0, failed: 0, rescheduled: 0 });
  const delivery = [...store.state.deliveries.values()][0];
  assert.equal(delivery.status, "skipped");
});

test("a malformed report.submitted payload is marked processed with a skip note, never retried forever", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent({ payload: { template_id: "tpl-1" } })] // missing submission_id
  });
  stubFetch(t, store.respond);

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON });
  assert.deepEqual(summary, { claimed: 1, processed: 0, skipped: 1, retried: 0, failed: 0, rescheduled: 0 });
  const outboxRow = store.state.outbox.get("outbox-1");
  assert.equal(outboxRow.status, "processed");
  assert.match(outboxRow.last_error, /^skipped:/);
});

test("a submission with no active distribution bindings is skipped, not retried", async (t) => {
  const store = makeStore({
    outbox: [outboxEvent()],
    submissions: [submissionFixture()],
    bindings: [] // no bindings configured for this template
  });
  stubFetch(t, store.respond);

  const summary = await processReportSubmittedEvents({ client: client(), now: NOON });
  assert.deepEqual(summary, { claimed: 1, processed: 0, skipped: 1, retried: 0, failed: 0, rescheduled: 0 });
  assert.match(store.state.outbox.get("outbox-1").last_error, /no active report_distribution_lists bindings/);
});
