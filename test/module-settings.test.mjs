import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveModuleState,
  impactSummary,
  validateModuleTogglePayload
} from "../src/lib/admin/module-settings.mjs";
import { validateModuleTogglePayload as validateFromHttp } from "../src/lib/http/validate.mjs";

test("facility override enabled flag wins over the org default", () => {
  const result = resolveEffectiveModuleState({ enabled: true }, { enabled: false });
  assert.equal(result.enabled, false);
  assert.equal(result.source, "facility-override");
});

test("org default applies when there is no facility override", () => {
  const result = resolveEffectiveModuleState({ enabled: true }, null);
  assert.equal(result.enabled, true);
  assert.equal(result.source, "org-default");
});

test("falls back to the module default when neither layer sets enabled", () => {
  const result = resolveEffectiveModuleState(null, null);
  assert.equal(result.enabled, false);
  assert.equal(result.source, "module-default");
});

test("a facility override present but with enabled null defers to the org default", () => {
  const result = resolveEffectiveModuleState({ enabled: true }, { enabled: null, config_patch_jsonb: {} });
  assert.equal(result.enabled, true);
  assert.equal(result.source, "org-default");
});

test("config is deep-merged: org base plus facility patch", () => {
  const result = resolveEffectiveModuleState(
    { enabled: true, config_jsonb: { a: 1, nested: { x: 1 } } },
    { enabled: true, config_patch_jsonb: { nested: { y: 2 } } }
  );
  assert.deepEqual(result.config, { a: 1, nested: { x: 1, y: 2 } });
});

test("an array in the facility patch replaces, it does not merge (deepMerge array branch)", () => {
  const result = resolveEffectiveModuleState(
    { enabled: true, config_jsonb: { tags: ["a", "b", "c"] } },
    { enabled: true, config_patch_jsonb: { tags: ["z"] } }
  );
  assert.deepEqual(result.config.tags, ["z"]);
});

test("an array in the patch also replaces an object value from the org layer", () => {
  const result = resolveEffectiveModuleState(
    { enabled: true, config_jsonb: { thresholds: { warn: 1 } } },
    { enabled: true, config_patch_jsonb: { thresholds: [5, 10] } }
  );
  assert.deepEqual(result.config.thresholds, [5, 10]);
});

test("resolveEffectiveModuleState also reads plain config keys", () => {
  const result = resolveEffectiveModuleState(
    { enabled: true, config: { a: 1 } },
    { enabled: true, config: { b: 2 } }
  );
  assert.deepEqual(result.config, { a: 1, b: 2 });
});

test("impactSummary produces a human string with correct verb and pluralization", () => {
  assert.equal(impactSummary("Incidents", true, 3), "Enabling Incidents affects 3 departments.");
  assert.equal(impactSummary("Incidents", false, 1), "Disabling Incidents affects 1 department.");
  assert.equal(impactSummary("Scheduling", false, 0), "Disabling Scheduling affects 0 departments.");
});

test("validateModuleTogglePayload is the shared http validator, not a duplicate", () => {
  assert.equal(validateModuleTogglePayload, validateFromHttp);
  assert.equal(validateModuleTogglePayload({ enabled: true }).valid, true);
  assert.equal(validateModuleTogglePayload({ enabled: "yes" }).valid, false);
});
