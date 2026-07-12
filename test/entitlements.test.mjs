import test from "node:test";
import assert from "node:assert/strict";
import {
  entitlementsFor,
  isEntitled,
  usageStatus,
  flagState
} from "../src/lib/admin/entitlements.mjs";
import { resolveEffectiveSettings } from "../src/lib/settings-registry.mjs";

test("entitlementsFor merges plan object entitlements with add-ons", () => {
  const plan = { feature_entitlements_jsonb: { cert_policies: true, notification_routing: true } };
  const addons = [{ feature_entitlements_jsonb: { audit_export: true } }];
  const merged = entitlementsFor(plan, addons);
  assert.deepEqual(merged, { cert_policies: true, notification_routing: true, audit_export: true });
});

test("entitlementsFor accepts an array of keys and ignores false values", () => {
  assert.deepEqual(entitlementsFor({ feature_entitlements_jsonb: ["cert_policies"] }), { cert_policies: true });
  assert.deepEqual(entitlementsFor({ feature_entitlements_jsonb: { cert_policies: true, x: false } }), {
    cert_policies: true
  });
});

test("entitlementsFor fails closed for a missing/null plan", () => {
  assert.deepEqual(entitlementsFor(null), {});
  assert.deepEqual(entitlementsFor(undefined), {});
  assert.equal(isEntitled(entitlementsFor(null), "cert_policies"), false);
});

test("isEntitled only returns true for an exact true entry", () => {
  const ent = { cert_policies: true };
  assert.equal(isEntitled(ent, "cert_policies"), true);
  assert.equal(isEntitled(ent, "notification_routing"), false);
  assert.equal(isEntitled(null, "cert_policies"), false);
});

test("usageStatus thresholds are inclusive at 80/90/100", () => {
  assert.deepEqual(usageStatus(79, 100), { level: "ok", pct: 79 });
  assert.deepEqual(usageStatus(80, 100), { level: "warn80", pct: 80 });
  assert.deepEqual(usageStatus(89, 100), { level: "warn80", pct: 89 });
  assert.deepEqual(usageStatus(90, 100), { level: "warn90", pct: 90 });
  assert.deepEqual(usageStatus(99, 100), { level: "warn90", pct: 99 });
  assert.deepEqual(usageStatus(100, 100), { level: "exceeded", pct: 100 });
  assert.deepEqual(usageStatus(150, 100), { level: "exceeded", pct: 150 });
});

test("usageStatus treats a null/zero limit as unlimited", () => {
  assert.deepEqual(usageStatus(500, null), { level: "ok", pct: 0 });
  assert.deepEqual(usageStatus(500, 0), { level: "ok", pct: 0 });
});

test("usageStatus accepts a counter object with a value field", () => {
  assert.deepEqual(usageStatus({ value: 90 }, 100), { level: "warn90", pct: 90 });
});

const FLAG = { id: "flag-1", default_state: false };

test("flagState precedence: facility rule beats org rule beats default", () => {
  const rules = [
    { feature_flag_id: "flag-1", scope_type: "organization", scope_id: "org-1", state: true, rollout_percentage: null },
    { feature_flag_id: "flag-1", scope_type: "facility", scope_id: "fac-1", state: false, rollout_percentage: null }
  ];
  // Facility rule (false) wins over org rule (true).
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", facilityId: "fac-1" }), false);
  // Without a matching facility rule, the org rule (true) applies.
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", facilityId: "fac-other" }), true);
  // No matching rule at all -> default_state.
  assert.equal(flagState(FLAG, rules, { organizationId: "org-other", facilityId: "fac-other" }), false);
});

test("flagState percentage rollout compares bucket to rollout_percentage", () => {
  const rules = [
    { feature_flag_id: "flag-1", scope_type: "organization", scope_id: "org-1", state: true, rollout_percentage: 40 }
  ];
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", bucket: 39 }), true);
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", bucket: 40 }), false);
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", bucket: 0 }), true);
});

test("flagState honors the active time window", () => {
  const rules = [
    {
      feature_flag_id: "flag-1",
      scope_type: "organization",
      scope_id: "org-1",
      state: true,
      rollout_percentage: null,
      starts_at: "2026-01-01T00:00:00Z",
      ends_at: "2026-02-01T00:00:00Z"
    }
  ];
  // Inside the window -> rule applies (true).
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", now: new Date("2026-01-15T00:00:00Z") }), true);
  // Before the window -> rule ignored, falls to default (false).
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", now: new Date("2025-12-15T00:00:00Z") }), false);
  // After the window (end is exclusive) -> ignored.
  assert.equal(flagState(FLAG, rules, { organizationId: "org-1", now: new Date("2026-02-01T00:00:00Z") }), false);
});

test("resolveEffectiveSettings filters entitlement-gated keys when entitlements are supplied", () => {
  // No entitlements argument -> no filtering (backward compatible): gated keys present.
  const unfiltered = resolveEffectiveSettings({});
  assert.ok(Object.prototype.hasOwnProperty.call(unfiltered, "scheduling.certEnforcementMode"));
  assert.ok(Object.prototype.hasOwnProperty.call(unfiltered, "reports.quietHoursStart"));

  // Entitlements missing cert_policies/notification_routing -> gated keys removed.
  const filtered = resolveEffectiveSettings({ entitlements: {} });
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "scheduling.certEnforcementMode"));
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "reports.quietHoursStart"));
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "reports.quietHoursEnd"));
  // Ungated keys stay.
  assert.ok(Object.prototype.hasOwnProperty.call(filtered, "scheduling.publishCadenceDays"));

  // Entitlements granting cert_policies -> that key returns, quiet-hours still gone.
  const partial = resolveEffectiveSettings({ entitlements: { cert_policies: true } });
  assert.ok(Object.prototype.hasOwnProperty.call(partial, "scheduling.certEnforcementMode"));
  assert.ok(!Object.prototype.hasOwnProperty.call(partial, "reports.quietHoursStart"));
});
