import test from "node:test";
import assert from "node:assert/strict";
import {
  settingsRegistry,
  getDefinition,
  settingsForModule,
  validateSettingValue,
  resolveEffectiveSettings,
  effectiveConfig,
  configValue
} from "../src/lib/settings-registry.mjs";

test("getDefinition and settingsForModule expose the catalog", () => {
  const def = getDefinition("training.recertWindowDays");
  assert.equal(def.module, "training");
  assert.equal(def.default, 30);
  assert.equal(getDefinition("nope.nope"), null);
  const scheduling = settingsForModule("scheduling");
  assert.ok(scheduling.length >= 5);
  assert.ok(scheduling.every((d) => d.module === "scheduling"));
});

test("every default self-validates", () => {
  for (const def of settingsRegistry) {
    const { valid, errors } = validateSettingValue(def.key, def.default);
    assert.equal(valid, true, `${def.key}: ${errors.join(", ")}`);
  }
});

test("validateSettingValue enforces boolean dataType", () => {
  assert.equal(validateSettingValue("scheduling.conflictCheckEnabled", true).valid, true);
  assert.equal(validateSettingValue("scheduling.conflictCheckEnabled", "true").valid, false);
});

test("validateSettingValue enforces integer bounds", () => {
  assert.equal(validateSettingValue("reports.dailyReportDueHour", 18).valid, true);
  assert.equal(validateSettingValue("reports.dailyReportDueHour", 24).valid, false);
  assert.equal(validateSettingValue("reports.dailyReportDueHour", -1).valid, false);
  assert.equal(validateSettingValue("reports.dailyReportDueHour", 12.5).valid, false);
});

test("validateSettingValue enforces enum membership", () => {
  assert.equal(validateSettingValue("scheduling.certEnforcementMode", "warning").valid, true);
  assert.equal(validateSettingValue("scheduling.certEnforcementMode", "hard-block").valid, true);
  assert.equal(validateSettingValue("scheduling.certEnforcementMode", "soft").valid, false);
});

test("validateSettingValue enforces timeRange pattern", () => {
  assert.equal(validateSettingValue("reports.quietHoursStart", "22:00").valid, true);
  assert.equal(validateSettingValue("reports.quietHoursStart", "25:00").valid, false);
  assert.equal(validateSettingValue("reports.quietHoursStart", "2200").valid, false);
  assert.equal(validateSettingValue("reports.quietHoursStart", 2200).valid, false);
});

test("validateSettingValue rejects unknown keys", () => {
  const { valid, errors } = validateSettingValue("bogus.key", 1);
  assert.equal(valid, false);
  assert.match(errors[0], /unknown setting/);
});

test("resolveEffectiveSettings attributes source: facility > organization > default", () => {
  const resolved = resolveEffectiveSettings({
    orgLayer: { "training.recertWindowDays": 45, "communications.requireAckDefault": true },
    facilityLayer: { "training.recertWindowDays": 14 }
  });
  assert.deepEqual(resolved["training.recertWindowDays"], { value: 14, source: "facility" });
  assert.deepEqual(resolved["communications.requireAckDefault"], { value: true, source: "organization" });
  assert.deepEqual(resolved["scheduling.certEnforcementMode"], { value: "hard-block", source: "default" });
});

test("resolveEffectiveSettings can scope to a subset of definitions", () => {
  const resolved = resolveEffectiveSettings({
    facilityLayer: {},
    definitions: settingsForModule("incidents")
  });
  const keys = Object.keys(resolved);
  assert.ok(keys.includes("incidents.escalationSlaHours"));
  assert.ok(!keys.includes("scheduling.publishCadenceDays"));
});

test("null/undefined layer values fall through to the next source", () => {
  const resolved = resolveEffectiveSettings({
    orgLayer: { "reports.dailyReportDueHour": 9 },
    facilityLayer: { "reports.dailyReportDueHour": null }
  });
  assert.deepEqual(resolved["reports.dailyReportDueHour"], { value: 9, source: "organization" });
});

test("effectiveConfig and configValue flatten to plain key/value with defaults", () => {
  const config = effectiveConfig({ facilityLayer: { "training.recertWindowDays": 7 } });
  assert.equal(config["training.recertWindowDays"], 7);
  assert.equal(config["scheduling.certEnforcementMode"], "hard-block");
  assert.equal(configValue({}, "workOrders.defaultPriority"), "medium");
  assert.equal(configValue({ "workOrders.defaultPriority": "urgent" }, "workOrders.defaultPriority"), "urgent");
});
