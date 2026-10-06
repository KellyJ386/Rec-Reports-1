import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShiftWindow,
  selectShiftsInWindow,
  shiftQueryBounds,
  resolveMessageAudience,
  audienceShiftWindow
} from "../src/lib/communications.mjs";
import { loadAudienceResolutionContext } from "../src/lib/communications-audience.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

// CM-12: shift-targeted audiences. Shifts are evaluated on their own
// starts_at/ends_at timestamps, so midnight rollover needs no special casing.

const SHIFTS = [
  // Overnight shift, 22:00 Aug 12 -> 06:00 Aug 13 (UTC).
  { id: "s-night", starts_at: "2026-08-12T22:00:00Z", ends_at: "2026-08-13T06:00:00Z", department_id: "d-aq", status: "published" },
  // Morning shift overlapping the end of the night shift.
  { id: "s-open", starts_at: "2026-08-13T05:00:00Z", ends_at: "2026-08-13T13:00:00Z", department_id: "d-fd", status: "published" },
  // Two shifts starting simultaneously at 13:00.
  { id: "s-mid-a", starts_at: "2026-08-13T13:00:00Z", ends_at: "2026-08-13T21:00:00Z", department_id: "d-aq", status: "published" },
  { id: "s-mid-b", starts_at: "2026-08-13T13:00:00Z", ends_at: "2026-08-13T17:00:00Z", department_id: "d-fd", status: "assigned" },
  { id: "s-late", starts_at: "2026-08-13T17:00:00Z", ends_at: "2026-08-14T01:00:00Z", department_id: "d-aq", status: "published" },
  { id: "s-cancelled", starts_at: "2026-08-13T13:00:00Z", ends_at: "2026-08-13T20:00:00Z", department_id: "d-aq", status: "cancelled" },
  { id: "s-deleted", starts_at: "2026-08-13T13:00:00Z", ends_at: "2026-08-13T20:00:00Z", department_id: "d-aq", status: "published", deleted_at: "2026-08-01T00:00:00Z" }
];

const ASSIGNMENTS = [
  { shift_id: "s-night", employee_id: "e-1" },
  { shift_id: "s-open", employee_id: "e-2" },
  { shift_id: "s-open", employee_id: "e-1" },
  { shift_id: "s-mid-a", employee_id: "e-3" },
  { shift_id: "s-mid-b", employee_id: "e-4" },
  { shift_id: "s-late", employee_id: "e-5" }
];

test("normalizeShiftWindow accepts current/next, ranges, the legacy start/end keys, and rejects anything else", () => {
  assert.deepEqual(normalizeShiftWindow("current"), { kind: "current" });
  assert.deepEqual(normalizeShiftWindow(" NEXT "), { kind: "next" });
  assert.deepEqual(normalizeShiftWindow({ kind: "next" }), { kind: "next" });
  const range = normalizeShiftWindow({ from: "2026-08-13T00:00:00Z", to: "2026-08-13T12:00:00Z" });
  assert.equal(range.kind, "range");
  assert.equal(range.from.toISOString(), "2026-08-13T00:00:00.000Z");
  const legacy = normalizeShiftWindow({ start: "2026-08-13T00:00:00Z", end: "2026-08-13T23:59:59Z" });
  assert.equal(legacy.kind, "range");
  // Idempotent on an already-normalized range.
  assert.equal(normalizeShiftWindow(range).kind, "range");

  assert.equal(normalizeShiftWindow(null), null);
  assert.equal(normalizeShiftWindow("tomorrow"), null);
  assert.equal(normalizeShiftWindow({ from: "2026-08-13T12:00:00Z", to: "2026-08-13T00:00:00Z" }), null);
  assert.equal(normalizeShiftWindow({ from: "not-a-date", to: "2026-08-13T00:00:00Z" }), null);
  // Span cap: 31 days.
  assert.equal(normalizeShiftWindow({ from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }), null);
  assert.equal(normalizeShiftWindow([]), null);
});

test("current shift: midnight rollover -- an overnight shift is current at 02:00 the next calendar day", () => {
  const ids = selectShiftsInWindow(SHIFTS, "current", new Date("2026-08-13T02:00:00Z"));
  assert.deepEqual(ids, ["s-night"]);
});

test("current shift: multi-shift overlap returns every in-progress shift", () => {
  const ids = selectShiftsInWindow(SHIFTS, "current", new Date("2026-08-13T05:30:00Z"));
  assert.deepEqual(ids, ["s-night", "s-open"]);
});

test("current shift: start is inclusive, end is exclusive; cancelled and soft-deleted shifts never count", () => {
  // 13:00 exactly: s-open (ends 13:00) is over, the two 13:00 starters are in.
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "current", new Date("2026-08-13T13:00:00Z")), ["s-mid-a", "s-mid-b"]);
  // 06:00 exactly: the night shift (ends 06:00) is over, s-open is still going.
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "current", new Date("2026-08-13T06:00:00Z")), ["s-open"]);
});

test("next shift: the earliest upcoming start, with simultaneous starts as one wave", () => {
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "next", new Date("2026-08-13T06:00:00Z")), ["s-mid-a", "s-mid-b"]);
  // Strictly after now: at 13:00 sharp the 13:00 wave is current, the 17:00 shift is next.
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "next", new Date("2026-08-13T13:00:00Z")), ["s-late"]);
  // Before the overnight shift starts, the next wave is that overnight shift.
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "next", new Date("2026-08-12T21:00:00Z")), ["s-night"]);
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "next", new Date("2026-08-20T00:00:00Z")), []);
});

test("range window: any live shift overlapping [from, to), optionally narrowed to one department", () => {
  const window = { from: "2026-08-13T12:00:00Z", to: "2026-08-13T14:00:00Z" };
  assert.deepEqual(selectShiftsInWindow(SHIFTS, window, new Date()), ["s-mid-a", "s-mid-b", "s-open"]);
  assert.deepEqual(selectShiftsInWindow(SHIFTS, window, new Date(), { departmentId: "d-fd" }), ["s-mid-b", "s-open"]);
  // A shift ending exactly at `from` does not overlap.
  assert.deepEqual(
    selectShiftsInWindow(SHIFTS, { from: "2026-08-13T13:00:00Z", to: "2026-08-13T13:30:00Z" }, new Date()),
    ["s-mid-a", "s-mid-b"]
  );
});

test("a malformed window selects nothing", () => {
  assert.deepEqual(selectShiftsInWindow(SHIFTS, "someday", new Date()), []);
  assert.deepEqual(selectShiftsInWindow(SHIFTS, null, new Date()), []);
});

test("shiftQueryBounds covers current (at now), next (7-day lookahead) and range windows", () => {
  const now = new Date("2026-08-13T06:00:00Z");
  const current = shiftQueryBounds(["current"], now);
  assert.equal(current.endsAfter.toISOString(), now.toISOString());
  assert.ok(current.startsBefore > now);
  const next = shiftQueryBounds(["next"], now);
  assert.equal(next.startsBefore.getTime() - 1, now.getTime() + 7 * 24 * 3600 * 1000);
  const both = shiftQueryBounds(["current", { from: "2026-08-10T00:00:00Z", to: "2026-08-11T00:00:00Z" }], now);
  assert.equal(both.endsAfter.toISOString(), "2026-08-10T00:00:00.000Z");
  assert.equal(shiftQueryBounds([], now), null);
  assert.equal(shiftQueryBounds(["nonsense"], now), null);
});

test("resolveMessageAudience: a specific shift id resolves that shift's assignees (audience_ref_id contract unchanged)", () => {
  const message = { audiences: [{ audience_type: "shift", audience_ref_id: "s-open", rule_jsonb: {} }] };
  assert.deepEqual(resolveMessageAudience(message, { shiftAssignments: ASSIGNMENTS }), ["e-1", "e-2"]);
  // pure { type, id } shape still works.
  assert.deepEqual(resolveMessageAudience({ audiences: [{ type: "shift", id: "s-late" }] }, { shiftAssignments: ASSIGNMENTS }), ["e-5"]);
});

test("resolveMessageAudience: a ref-less shift audience resolves its rule window against the shifts context", () => {
  const message = { audiences: [{ audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "current" } }] };
  const context = { shifts: SHIFTS, shiftAssignments: ASSIGNMENTS, now: new Date("2026-08-13T05:30:00Z") };
  assert.deepEqual(resolveMessageAudience(message, context), ["e-1", "e-2"]);
  const next = { audiences: [{ audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "next" } }] };
  assert.deepEqual(resolveMessageAudience(next, { ...context, now: new Date("2026-08-13T06:00:00Z") }), ["e-3", "e-4"]);
});

test("resolveMessageAudience: department narrowing, publish-time fallback window, and no window = nobody", () => {
  const narrowed = {
    audiences: [{ audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "next", departmentId: "d-fd" } }]
  };
  const context = { shifts: SHIFTS, shiftAssignments: ASSIGNMENTS, now: new Date("2026-08-13T06:00:00Z") };
  assert.deepEqual(resolveMessageAudience(narrowed, context), ["e-4"]);

  const bare = { audiences: [{ audience_type: "shift", audience_ref_id: null, rule_jsonb: {} }] };
  assert.deepEqual(resolveMessageAudience(bare, context), []);
  assert.deepEqual(resolveMessageAudience(bare, { ...context, shiftWindow: "next" }), ["e-3", "e-4"]);
  assert.equal(audienceShiftWindow(bare.audiences[0], null), null);
});

test("resolveMessageAudience: declined/cancelled/soft-deleted assignments never resolve", () => {
  const message = { audiences: [{ audience_type: "shift", audience_ref_id: "s-open" }] };
  const assignments = [
    { shift_id: "s-open", employee_id: "e-1", status: "approved" },
    { shift_id: "s-open", employee_id: "e-2", status: "declined" },
    { shift_id: "s-open", employee_id: "e-3", status: "cancelled" },
    { shift_id: "s-open", employee_id: "e-4", status: "pending", deleted_at: "2026-08-01T00:00:00Z" }
  ];
  assert.deepEqual(resolveMessageAudience(message, { shiftAssignments: assignments }), ["e-1"]);
});

test("resolveMessageAudience: overlapping audiences dedupe across a shift window and an employee audience", () => {
  const message = {
    audiences: [
      { audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "current" } },
      { audience_type: "employee", audience_ref_id: "e-1" },
      { audience_type: "shift", audience_ref_id: "s-open" }
    ]
  };
  const context = { shifts: SHIFTS, shiftAssignments: ASSIGNMENTS, now: new Date("2026-08-13T05:30:00Z") };
  assert.deepEqual(resolveMessageAudience(message, context), ["e-1", "e-2"]);
});

// --- loader ------------------------------------------------------------------

function stubFetch(t, respond) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    captured.push({ table, method: init.method, url: parsed });
    return { ok: true, status: 200, text: async () => JSON.stringify(respond(table, parsed) ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

const client = () => createClient({ url: "https://example.supabase.co", key: "k" });

test("loadAudienceResolutionContext fetches window shifts + their assignments for a ref-less shift audience", async (t) => {
  const captured = stubFetch(t, (table) => {
    if (table === "schedule_shifts") return SHIFTS.filter((s) => !s.deleted_at && s.status !== "cancelled");
    if (table === "shift_assignments") return ASSIGNMENTS.filter((a) => ["s-open", "s-night"].includes(a.shift_id));
    return [];
  });
  const audiences = [{ id: "a1", audience_type: "shift", audience_ref_id: null, rule_jsonb: { window: "current" } }];
  const loaded = await loadAudienceResolutionContext(client(), "fac-1", audiences, { now: new Date("2026-08-13T05:30:00Z") });
  assert.equal(loaded.unresolvedAudiences.length, 0);

  const shiftQuery = captured.find((c) => c.table === "schedule_shifts");
  assert.ok(shiftQuery, "expected a schedule_shifts query");
  assert.equal(shiftQuery.url.searchParams.get("facility_id"), "eq.fac-1");
  assert.equal(shiftQuery.url.searchParams.get("status"), "neq.cancelled");
  assert.ok(shiftQuery.url.searchParams.get("ends_at").startsWith("gt.2026-08-13T05:30:00.000Z"));

  const assignmentQuery = captured.find((c) => c.table === "shift_assignments");
  assert.equal(assignmentQuery.url.searchParams.get("shift_id"), "in.(s-night,s-open)");
});

test("loadAudienceResolutionContext: a ref-less shift audience with no window anywhere is unresolved and costs no shift query", async (t) => {
  const captured = stubFetch(t, () => []);
  const audiences = [{ id: "a1", audience_type: "shift", audience_ref_id: null, rule_jsonb: {} }];
  const loaded = await loadAudienceResolutionContext(client(), "fac-1", audiences, { now: new Date() });
  assert.equal(loaded.unresolvedAudiences.length, 1);
  assert.equal(captured.length, 0);

  // The publish-time fallback window rescues it.
  const rescued = await loadAudienceResolutionContext(client(), "fac-1", audiences, { shiftWindow: "next", now: new Date() });
  assert.equal(rescued.unresolvedAudiences.length, 0);
  assert.ok(captured.some((c) => c.table === "schedule_shifts"));
});
