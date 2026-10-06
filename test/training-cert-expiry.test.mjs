import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { scanCertificationExpiry, parseLeadDays, noticeFor, dedupeKeyFor } from "../src/lib/training-cert-expiry.mjs";

const DAY = 86400000;
const NOW = new Date("2026-07-06T12:00:00.000Z");
const FAC_A = "fac-a";
const FAC_B = "fac-b";

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

function dateIn(days, from = NOW) {
  return new Date(from.getTime() + days * DAY).toISOString().slice(0, 10);
}

// A small in-memory PostgREST (eq / neq / in / gte / lte / is.null filters,
// the `col->>key` JSON path filter, ON CONFLICT DO NOTHING, PATCH, DELETE) --
// enough to run the evaluator through several real passes.
function valueOf(row, column) {
  if (column.includes("->>")) {
    const [base, key] = column.split("->>");
    return row[base]?.[key];
  }
  return row[column];
}

function matches(row, column, expression) {
  const value = valueOf(row, column);
  if (expression === "is.null") return value === null || value === undefined;
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot);
  const operand = expression.slice(dot + 1);
  switch (op) {
    case "eq":
      return String(value) === operand;
    case "neq":
      return String(value) !== operand;
    case "gte":
      return String(value) >= operand;
    case "lte":
      return String(value) <= operand;
    case "in":
      return operand.slice(1, -1).split(",").includes(String(value));
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

function makeDb(initial) {
  return { tables: structuredClone(initial), log: [], fail: null };
}

function stubDb(t, db) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    db.log.push({ table, method, url: parsed, body });
    if (db.fail?.(table, method)) {
      return { ok: false, status: 500, text: async () => JSON.stringify({ message: "boom" }) };
    }
    const rows = db.tables[table] ?? (db.tables[table] = []);
    const reserved = new Set(["select", "order", "limit", "offset", "on_conflict"]);
    const filter = (row) =>
      [...parsed.searchParams.entries()].every(([column, expression]) => reserved.has(column) || matches(row, column, expression));
    if (method === "GET") {
      let result = rows.filter(filter);
      const limit = parsed.searchParams.get("limit");
      if (limit) result = result.slice(0, Number(limit));
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    }
    if (method === "POST") {
      const conflict = parsed.searchParams.get("on_conflict")?.split(",");
      const inserted = [];
      for (const row of body) {
        if (conflict && rows.some((existing) => conflict.every((column) => (existing[column] ?? null) === (row[column] ?? null)))) continue;
        const stored = { id: `${table}-${rows.length + 1}-${db.log.length}`, ...row };
        rows.push(stored);
        inserted.push(stored);
      }
      return { ok: true, status: 201, text: async () => JSON.stringify(inserted) };
    }
    if (method === "DELETE") {
      const keep = rows.filter((row) => !filter(row));
      const removed = rows.length - keep.length;
      db.tables[table] = keep;
      return { ok: true, status: 200, text: async () => JSON.stringify(Array(removed).fill({})) };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

function cert(id, facility, employee, expiresAt, extra = {}) {
  return { id, facility_id: facility, employee_id: employee, certification_type_id: "type-cpr", expires_at: expiresAt, status: "active", deleted_at: null, ...extra };
}

function route(eventCode, facility = FAC_A, extra = {}) {
  return { id: `route-${eventCode}-${facility}`, facility_id: facility, event_code: eventCode, priority: 1, active: true, route_jsonb: { channels: ["in_app"], distributionListId: `list-${facility}` }, ...extra };
}

function baseTables(overrides = {}) {
  return {
    employee_certifications: [],
    certification_types: [{ id: "type-cpr", code: "CPR", name: "CPR" }],
    notification_routes: [route("cert.expiring"), route("cert.expired")],
    distribution_lists: [{ id: `list-${FAC_A}`, facility_id: FAC_A, name: "Managers", active: true }],
    distribution_list_members: [
      { id: "m1", facility_id: FAC_A, distribution_list_id: `list-${FAC_A}`, member_type: "employee", member_ref_id: "mgr-1" }
    ],
    employees: [
      { id: "mgr-1", facility_id: FAC_A },
      { id: "emp-1", facility_id: FAC_A },
      { id: "emp-2", facility_id: FAC_A },
      { id: "emp-b", facility_id: FAC_B }
    ],
    training_cert_notices: [],
    certification_events: [],
    notification_jobs: [],
    ...overrides
  };
}

const jobs = (db, eventType) => db.tables.notification_jobs.filter((job) => !eventType || job.event_type === eventType);

// --- pure helpers ---------------------------------------------------------
test("parseLeadDays sorts, de-duplicates and falls back to the default on junk", () => {
  assert.deepEqual(parseLeadDays("30,14,7"), [7, 14, 30]);
  assert.deepEqual(parseLeadDays("7, 30,7"), [7, 30]);
  assert.deepEqual(parseLeadDays("abc"), [7, 14, 30]);
  assert.deepEqual(parseLeadDays(""), [7, 14, 30]);
  assert.deepEqual(parseLeadDays("0,9999"), [7, 14, 30]);
});

test("noticeFor: the tightest reached lead wins, expired is its own kind, revoked and no-expiry are ignored", () => {
  const leads = [7, 14, 30];
  assert.deepEqual(noticeFor(cert("c", FAC_A, "e", dateIn(40)), NOW, leads), null);
  assert.deepEqual(noticeFor(cert("c", FAC_A, "e", dateIn(25)), NOW, leads), { kind: "expiring", leadDays: 30, daysUntil: 25 });
  assert.equal(noticeFor(cert("c", FAC_A, "e", dateIn(10)), NOW, leads).leadDays, 14);
  assert.equal(noticeFor(cert("c", FAC_A, "e", dateIn(3)), NOW, leads).leadDays, 7);
  assert.deepEqual(noticeFor(cert("c", FAC_A, "e", dateIn(-2)), NOW, leads), { kind: "expired", leadDays: 0 });
  assert.equal(noticeFor(cert("c", FAC_A, "e", dateIn(3), { status: "revoked" }), NOW, leads), null);
  assert.equal(noticeFor(cert("c", FAC_A, "e", null), NOW, leads), null);
  assert.equal(dedupeKeyFor({ id: "c1", expires_at: "2026-08-01" }, { kind: "expiring", leadDays: 14 }), "c1:expiring:14:2026-08-01");
});

// --- evaluator -------------------------------------------------------------
test("an expiring certification gets ONE job at the tightest reached lead, to the route's list plus the owner", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(10))] }));
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.expiringNotices, 1);
  assert.equal(summary.jobsEnqueued, 1);
  assert.deepEqual(summary.errors, []);
  const [job] = jobs(db, "cert.expiring");
  assert.equal(job.facility_id, FAC_A);
  assert.deepEqual([...job.payload_jsonb.recipients].sort(), ["emp-1", "mgr-1"]);
  assert.equal(job.payload_jsonb.leadDays, 14);
  assert.equal(job.payload_jsonb.dedupeKey, `c1:expiring:14:${dateIn(10)}`);
  assert.equal(job.payload_jsonb.employeeCertificationId, "c1");
  assert.equal(job.payload_jsonb.quietHoursBypass, false);
  assert.equal(job.scheduled_for, NOW.toISOString());
  assert.deepEqual(db.tables.training_cert_notices.map((n) => [n.notice_kind, n.lead_days, n.cert_expires_at]), [["expiring", 14, dateIn(10)]]);
  // the 0058 dedupe_key column is deliberately never set (its trigger would collapse every cert notice)
  assert.equal("dedupe_key" in job, false);
});

test("idempotency: re-running produces no second job, event or claim; the next lead crossing produces exactly one more", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(10))] }));
  stubDb(t, db);
  await scanCertificationExpiry(client(), { now: NOW });
  const again = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(again.jobsEnqueued, 0);
  assert.equal(again.deduped, 1);
  assert.equal(jobs(db).length, 1);
  assert.equal(db.tables.training_cert_notices.length, 1);

  // four days later the 7-day lead is reached: one new notice, the 14-day one is not repeated
  const later = new Date(NOW.getTime() + 4 * DAY);
  const crossing = await scanCertificationExpiry(client(), { now: later });
  assert.equal(crossing.jobsEnqueued, 1);
  assert.deepEqual(jobs(db).map((job) => job.payload_jsonb.leadDays), [14, 7]);
  assert.equal((await scanCertificationExpiry(client(), { now: later })).jobsEnqueued, 0);
});

test("a certification still more than the longest lead away produces nothing", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(90))] }));
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.scanned, 1);
  assert.equal(jobs(db).length, 0);
  assert.equal(db.tables.training_cert_notices.length, 0);
});

test("an expired certification writes exactly one 'expired' event and one cert.expired job, once", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(-3))] }));
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.expiredNotices, 1);
  assert.equal(summary.eventsWritten, 1);
  assert.equal(summary.jobsEnqueued, 1);
  assert.equal(db.tables.certification_events.length, 1);
  const event = db.tables.certification_events[0];
  assert.equal(event.event_type, "expired");
  assert.equal(event.employee_certification_id, "c1");
  assert.equal(event.facility_id, FAC_A);
  assert.equal(event.payload_jsonb.expiresAt, dateIn(-3));
  assert.equal(jobs(db, "cert.expired").length, 1);

  const again = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(again.eventsWritten, 0);
  assert.equal(again.jobsEnqueued, 0);
  assert.equal(db.tables.certification_events.length, 1);
  assert.equal(jobs(db).length, 1);
});

test("a renewed certification (new expiry date) starts a fresh set of notices", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(10))] }));
  stubDb(t, db);
  await scanCertificationExpiry(client(), { now: NOW });
  db.tables.employee_certifications[0].expires_at = dateIn(12); // renewed to a different date, still in range
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.jobsEnqueued, 1);
  assert.equal(db.tables.training_cert_notices.length, 2);
});

test("facility lead times are configurable and each facility uses its own route", async (t) => {
  const db = makeDb(
    baseTables({
      employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(45)), cert("c2", FAC_B, "emp-b", dateIn(45))],
      notification_routes: [route("cert.expiring", FAC_A), route("cert.expiring", FAC_B)],
      distribution_lists: [
        { id: `list-${FAC_A}`, facility_id: FAC_A, name: "A", active: true },
        { id: `list-${FAC_B}`, facility_id: FAC_B, name: "B", active: true }
      ],
      distribution_list_members: [
        { id: "m1", facility_id: FAC_A, distribution_list_id: `list-${FAC_A}`, member_type: "employee", member_ref_id: "mgr-1" },
        { id: "m2", facility_id: FAC_B, distribution_list_id: `list-${FAC_B}`, member_type: "employee", member_ref_id: "emp-b" }
      ],
      modules: [{ id: "mod-training", code: "training" }],
      facilities: [{ id: FAC_A, organization_id: "org-1" }, { id: FAC_B, organization_id: "org-1" }],
      organization_module_settings: [],
      facility_module_overrides: [
        // facility A reaches out to 60 days; facility B keeps the 30/14/7 default
        { facility_id: FAC_A, module_id: "mod-training", config_patch_jsonb: { "training.certExpiryLeadDays": "60,3" } }
      ]
    })
  );
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.jobsEnqueued, 1);
  const [job] = jobs(db);
  assert.equal(job.facility_id, FAC_A);
  assert.equal(job.payload_jsonb.leadDays, 60);
  assert.equal(job.payload_jsonb.route_id, `route-cert.expiring-${FAC_A}`);
  // facility B's 45-day-out cert is not yet within its 30-day lead
  assert.equal(db.tables.training_cert_notices.every((notice) => notice.facility_id === FAC_A), true);
});

test("training.certExpiryNotifyEnabled=false suppresses 'expiring' notices but an expiry still records its event", async (t) => {
  const db = makeDb(
    baseTables({
      employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(10)), cert("c2", FAC_A, "emp-2", dateIn(-1))],
      modules: [{ id: "mod-training", code: "training" }],
      facilities: [{ id: FAC_A, organization_id: "org-1" }],
      organization_module_settings: [],
      facility_module_overrides: [
        { facility_id: FAC_A, module_id: "mod-training", config_patch_jsonb: { "training.certExpiryNotifyEnabled": false } }
      ]
    })
  );
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.disabled, 1);
  assert.equal(summary.expiringNotices, 0);
  assert.equal(summary.eventsWritten, 1);
  assert.equal(jobs(db).length, 0);
});

test("no active route: 'expiring' claims nothing (so a later route still sends); 'expired' still records its event", async (t) => {
  const db = makeDb(
    baseTables({
      employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(10)), cert("c2", FAC_A, "emp-2", dateIn(-1))],
      notification_routes: []
    })
  );
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.noRoute, 2);
  assert.equal(summary.eventsWritten, 1);
  assert.equal(jobs(db).length, 0);
  assert.deepEqual(db.tables.training_cert_notices.map((n) => n.notice_kind), ["expired"]);

  db.tables.notification_routes.push(route("cert.expiring"));
  const later = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(later.jobsEnqueued, 1);
  assert.equal(jobs(db, "cert.expiring").length, 1);
});

test("claim revert: a failure after the claim releases it, records the error, and the retry succeeds exactly once", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(10))] }));
  stubDb(t, db);
  db.fail = (table, method) => table === "notification_jobs" && method === "POST";
  const failed = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0].certificationId, "c1");
  assert.equal(failed.jobsEnqueued, 0);
  assert.equal(db.tables.training_cert_notices.length, 0, "the claim must be reverted");
  assert.equal(jobs(db).length, 0);

  db.fail = null;
  const retry = await scanCertificationExpiry(client(), { now: NOW });
  assert.deepEqual(retry.errors, []);
  assert.equal(retry.jobsEnqueued, 1);
  assert.equal(jobs(db).length, 1);
  assert.equal(db.tables.training_cert_notices.length, 1);
});

test("claim revert on an expiry: the event is written once even though the job failed and was retried", async (t) => {
  const db = makeDb(baseTables({ employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(-2))] }));
  stubDb(t, db);
  db.fail = (table, method) => table === "notification_jobs" && method === "POST";
  const failed = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(failed.errors.length, 1);
  assert.equal(db.tables.certification_events.length, 1);
  assert.equal(db.tables.training_cert_notices.length, 0);

  db.fail = null;
  const retry = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(retry.eventsWritten, 0, "the retry must not write a second 'expired' event");
  assert.equal(retry.jobsEnqueued, 1);
  assert.equal(db.tables.certification_events.length, 1);
  assert.equal(jobs(db).length, 1);
});

test("a failed revert is recorded and one bad certification never aborts the rest of the pass", async (t) => {
  const db = makeDb(
    baseTables({
      employee_certifications: [cert("c1", FAC_A, "emp-1", dateIn(5)), cert("c2", FAC_A, "emp-2", dateIn(6))]
    })
  );
  stubDb(t, db);
  let jobPosts = 0;
  db.fail = (table, method) => {
    if (table === "notification_jobs" && method === "POST") {
      jobPosts += 1;
      return jobPosts === 1; // only the first certification's job insert fails
    }
    return table === "training_cert_notices" && method === "DELETE"; // ...and so does its revert
  };
  const summary = await scanCertificationExpiry(client(), { now: NOW });
  assert.equal(summary.errors.length, 2);
  assert.equal(summary.errors[1].stage, "revert");
  assert.equal(summary.jobsEnqueued, 1, "the second certification was still processed");
  assert.equal(jobs(db).length, 1);
});

test("revoked, no-expiry and out-of-window certifications are ignored; quiet hours defer the job", async (t) => {
  const db = makeDb(
    baseTables({
      employee_certifications: [
        cert("revoked", FAC_A, "emp-1", dateIn(5), { status: "revoked" }),
        cert("noexp", FAC_A, "emp-1", null),
        cert("ancient", FAC_A, "emp-1", dateIn(-200)),
        cert("deleted", FAC_A, "emp-1", dateIn(5), { deleted_at: "2026-01-01" }),
        cert("live", FAC_A, "emp-2", dateIn(5))
      ]
    })
  );
  stubDb(t, db);
  const summary = await scanCertificationExpiry(client(), { now: NOW, config: { quietHoursStart: "11:00", quietHoursEnd: "13:00" } });
  assert.equal(summary.jobsEnqueued, 1);
  assert.equal(jobs(db)[0].payload_jsonb.employeeCertificationId, "live");
  assert.equal(jobs(db)[0].scheduled_for, "2026-07-06T13:00:00.000Z");
});
