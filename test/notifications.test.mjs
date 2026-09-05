import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRoute,
  expandDistributionList,
  isWithinQuietHours,
  buildNotificationJob
} from "../src/lib/admin/notifications.mjs";

test("resolveRoute returns the highest-priority active route for the event", () => {
  const routes = [
    { id: "r1", event_code: "incident.escalated", priority: 1, active: true },
    { id: "r2", event_code: "incident.escalated", priority: 5, active: true },
    { id: "r3", event_code: "incident.escalated", priority: 9, active: false },
    { id: "r4", event_code: "schedule.published", priority: 20, active: true }
  ];
  assert.equal(resolveRoute("incident.escalated", routes).id, "r2");
});

test("resolveRoute ignores inactive routes and returns null when none match", () => {
  const routes = [{ id: "r1", event_code: "incident.escalated", priority: 9, active: false }];
  assert.equal(resolveRoute("incident.escalated", routes), null);
  assert.equal(resolveRoute("nope", routes), null);
});

test("expandDistributionList dedupes employees and expands roles", () => {
  const list = { id: "list-1" };
  const members = [
    { distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { distribution_list_id: "list-1", member_type: "role", member_ref_id: "role-a" },
    { distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { distribution_list_id: "other", member_type: "employee", member_ref_id: "emp-9" }
  ];
  const roleAssignments = [
    { role_id: "role-a", employee_id: "emp-2" },
    { role_id: "role-a", employee_id: "emp-1" },
    { role_id: "role-b", employee_id: "emp-3" }
  ];
  const result = expandDistributionList(list, members, { roleAssignments });
  assert.deepEqual(result, ["emp-1", "emp-2"]);
});

test("expandDistributionList filters to a known employee roster when provided", () => {
  const list = { id: "list-1" };
  const members = [
    { distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { distribution_list_id: "list-1", member_type: "employee", member_ref_id: "ghost" }
  ];
  const result = expandDistributionList(list, members, { employees: [{ id: "emp-1" }] });
  assert.deepEqual(result, ["emp-1"]);
});

test("isWithinQuietHours handles a same-day window", () => {
  assert.equal(isWithinQuietHours("13:00", "09:00", "17:00"), true);
  assert.equal(isWithinQuietHours("08:59", "09:00", "17:00"), false);
  assert.equal(isWithinQuietHours("17:00", "09:00", "17:00"), false); // end is exclusive
});

test("isWithinQuietHours handles an overnight window spanning midnight", () => {
  assert.equal(isWithinQuietHours("23:30", "22:00", "06:00"), true);
  assert.equal(isWithinQuietHours("02:00", "22:00", "06:00"), true);
  assert.equal(isWithinQuietHours("12:00", "22:00", "06:00"), false);
  assert.equal(isWithinQuietHours("06:00", "22:00", "06:00"), false); // end exclusive
});

test("isWithinQuietHours defaults to the registry quiet-hours (22:00-06:00)", () => {
  // No explicit window -> pulls reports.quietHoursStart/End defaults.
  assert.equal(isWithinQuietHours("23:00"), true);
  assert.equal(isWithinQuietHours("09:00"), false);
});

test("isWithinQuietHours treats an equal window as no quiet hours", () => {
  assert.equal(isWithinQuietHours("05:00", "00:00", "00:00"), false);
});

test("buildNotificationJob shapes a notification_jobs row for the route", () => {
  const route = {
    id: "route-1",
    facility_id: "fac-1",
    priority: 5,
    route_jsonb: { channels: ["in_app", "email"] }
  };
  const job = buildNotificationJob("incident.escalated", route, ["emp-1", "emp-2"]);
  assert.equal(job.facility_id, "fac-1");
  assert.equal(job.event_type, "incident.escalated");
  assert.equal(job.status, "pending");
  assert.deepEqual(job.payload_jsonb, {
    route_id: "route-1",
    priority: 5,
    channels: ["in_app", "email"],
    recipients: ["emp-1", "emp-2"]
  });
});
