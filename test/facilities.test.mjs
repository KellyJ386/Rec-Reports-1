import test from "node:test";
import assert from "node:assert/strict";
import {
  validateFacilityInput,
  validateDepartmentInput,
  validateFacilitySettingsPatch
} from "../src/lib/admin/facilities.mjs";

test("validateFacilityInput accepts a full, well-formed facility", () => {
  const result = validateFacilityInput({
    name: "North Arena",
    timezone: "America/New_York",
    locale: "en-US"
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateFacilityInput accepts name only (timezone and locale optional)", () => {
  assert.equal(validateFacilityInput({ name: "West Rink" }).valid, true);
});

test("validateFacilityInput requires a non-empty name", () => {
  assert.equal(validateFacilityInput({ name: "   " }).valid, false);
  assert.equal(validateFacilityInput({ timezone: "America/New_York" }).valid, false);
  assert.equal(validateFacilityInput("nope").valid, false);
});

test("validateFacilityInput rejects a non-IANA timezone but keeps the name valid", () => {
  const result = validateFacilityInput({ name: "OK", timezone: "Pacific Time" });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /timezone/);
});

test("validateFacilityInput accepts UTC and deep zone names", () => {
  assert.equal(validateFacilityInput({ name: "A", timezone: "UTC" }).valid, true);
  assert.equal(
    validateFacilityInput({ name: "A", timezone: "America/Argentina/Salta" }).valid,
    true
  );
});

test("validateFacilityInput rejects a malformed locale", () => {
  assert.equal(validateFacilityInput({ name: "A", locale: "english" }).valid, false);
  assert.equal(validateFacilityInput({ name: "A", locale: "en_US" }).valid, false);
  assert.equal(validateFacilityInput({ name: "A", locale: "EN-us" }).valid, false);
});

test("validateFacilityInput reports multiple field errors at once", () => {
  const result = validateFacilityInput({ name: "", timezone: "bad zone", locale: "bad" });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
});

test("validateDepartmentInput requires a name", () => {
  assert.equal(validateDepartmentInput({ name: "Operations" }).valid, true);
  assert.equal(validateDepartmentInput({ name: "" }).valid, false);
  assert.equal(validateDepartmentInput({}).valid, false);
});

test("validateFacilitySettingsPatch accepts the seed-shaped settings", () => {
  const result = validateFacilitySettingsPatch({
    locale: "en-US",
    reporting: { dailyReportDueHour: 18 },
    notifications: { quietHoursStart: "22:00", quietHoursEnd: "06:00" }
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateFacilitySettingsPatch rejects an out-of-range due hour", () => {
  assert.equal(validateFacilitySettingsPatch({ reporting: { dailyReportDueHour: 24 } }).valid, false);
  assert.equal(validateFacilitySettingsPatch({ reporting: { dailyReportDueHour: -1 } }).valid, false);
  assert.equal(validateFacilitySettingsPatch({ reporting: { dailyReportDueHour: 9.5 } }).valid, false);
  assert.equal(validateFacilitySettingsPatch({ reporting: { dailyReportDueHour: "18" } }).valid, false);
});

test("validateFacilitySettingsPatch rejects malformed quiet hours", () => {
  assert.equal(
    validateFacilitySettingsPatch({ notifications: { quietHoursStart: "25:00" } }).valid,
    false
  );
  assert.equal(
    validateFacilitySettingsPatch({ notifications: { quietHoursEnd: "6:00" } }).valid,
    false
  );
  assert.equal(
    validateFacilitySettingsPatch({ notifications: { quietHoursStart: "22:60" } }).valid,
    false
  );
});

test("validateFacilitySettingsPatch rejects an invalid HH:MM time like 99:99", () => {
  assert.equal(
    validateFacilitySettingsPatch({ notifications: { quietHoursStart: "99:99" } }).valid,
    false
  );
  assert.equal(
    validateFacilitySettingsPatch({ notifications: { quietHoursEnd: "99:99" } }).valid,
    false
  );
});

test("validateFacilitySettingsPatch accepts a valid quiet-hours window in the canonical (flat) shape", () => {
  const result = validateFacilitySettingsPatch({
    notifications: { quietHoursStart: "21:30", quietHoursEnd: "05:15" }
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateFacilitySettingsPatch does not validate the legacy nested notifications.quietHours shape (unknown key is left alone)", () => {
  // Guards against the shape mismatch bug: a stray nested quietHours object is
  // not a recognized key, so it neither fails nor is treated as the real
  // quiet-hours value. Regression coverage for the facilities.js fix that
  // switched the admin UI to send the flat notifications.quietHoursStart /
  // notifications.quietHoursEnd keys the validator (and the rest of the
  // system) actually reads.
  const result = validateFacilitySettingsPatch({
    notifications: { quietHours: { start: "99:99", end: "99:99" } }
  });
  assert.equal(result.valid, true);
});

test("validateFacilitySettingsPatch rejects wrong container shapes", () => {
  assert.equal(validateFacilitySettingsPatch("nope").valid, false);
  assert.equal(validateFacilitySettingsPatch({ reporting: 5 }).valid, false);
  assert.equal(validateFacilitySettingsPatch({ notifications: [] }).valid, false);
});

test("validateFacilitySettingsPatch tolerates an empty patch and unknown keys", () => {
  assert.equal(validateFacilitySettingsPatch({}).valid, true);
  assert.equal(validateFacilitySettingsPatch({ somethingElse: true }).valid, true);
});
