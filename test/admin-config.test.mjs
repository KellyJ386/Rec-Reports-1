import test from "node:test";
import assert from "node:assert/strict";
import { buildConfigAuditEvent, isModuleEnabled, mergeSettings } from "../src/lib/admin-config.mjs";

test("mergeSettings applies tenant, facility, and department overrides deeply", () => {
  assert.deepEqual(
    mergeSettings(
      { notifications: { email: true, sms: false }, reports: { dueHour: 18 } },
      { notifications: { sms: true } },
      { reports: { dueHour: 20 } }
    ),
    { notifications: { email: true, sms: true }, reports: { dueHour: 20 } }
  );
});

test("isModuleEnabled lets facility overrides take precedence over tenant defaults", () => {
  assert.equal(isModuleEnabled({ enabled: true }, { enabled: false }), false);
  assert.equal(isModuleEnabled({ enabled: true }, {}), true);
});

test("buildConfigAuditEvent creates an audit payload for admin changes", () => {
  assert.deepEqual(
    buildConfigAuditEvent({
      facilityId: "facility-1",
      actorUserId: "user-1",
      entityTable: "facility_settings",
      entityId: "settings-1",
      before: { timezone: "UTC" },
      after: { timezone: "America/New_York" }
    }),
    {
      facility_id: "facility-1",
      actor_user_id: "user-1",
      event_type: "config.changed",
      entity_table: "facility_settings",
      entity_id: "settings-1",
      event_payload: { before: { timezone: "UTC" }, after: { timezone: "America/New_York" } }
    }
  );
});
