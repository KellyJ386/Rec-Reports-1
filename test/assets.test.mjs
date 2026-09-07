import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssetQuery,
  validateAssetCreate,
  buildAssetPayload,
  assetPickerOptions,
  findAssetName
} from "../src/public/js/assets.mjs";

test("buildAssetQuery with no filters only sets pagination", () => {
  const params = buildAssetQuery({ page: 1, pageSize: 20 });
  assert.equal(params.get("status"), null);
  assert.equal(params.get("category"), null);
  assert.equal(params.get("q"), null);
  assert.equal(params.get("limit"), "20");
  assert.equal(params.get("offset"), "0");
});

test("buildAssetQuery sets status only for a known enum value", () => {
  const good = buildAssetQuery({ status: "retired" });
  assert.equal(good.get("status"), "retired");

  const bad = buildAssetQuery({ status: "not_a_status" });
  assert.equal(bad.get("status"), null);
});

test("buildAssetQuery sets and trims category", () => {
  const params = buildAssetQuery({ category: "  mechanical  " });
  assert.equal(params.get("category"), "mechanical");
});

test("buildAssetQuery sets and trims q, omitting a blank one", () => {
  const withQuery = buildAssetQuery({ q: "  pump  " });
  assert.equal(withQuery.get("q"), "pump");

  const blank = buildAssetQuery({ q: "   " });
  assert.equal(blank.get("q"), null);
});

test("buildAssetQuery composes status, category, and q together", () => {
  const params = buildAssetQuery({ status: "active", category: "mechanical", q: "pump" });
  assert.equal(params.get("status"), "active");
  assert.equal(params.get("category"), "mechanical");
  assert.equal(params.get("q"), "pump");
});

test("buildAssetQuery computes offset from page and pageSize", () => {
  const page1 = buildAssetQuery({ page: 1, pageSize: 10 });
  const page2 = buildAssetQuery({ page: 2, pageSize: 10 });
  assert.equal(page1.get("offset"), "0");
  assert.equal(page2.get("offset"), "10");
});

test("buildAssetQuery clamps a sub-1 page and non-positive pageSize", () => {
  const params = buildAssetQuery({ page: 0, pageSize: -5 });
  assert.equal(params.get("offset"), "0");
  assert.equal(Number(params.get("limit")) > 0, true);
});

test("validateAssetCreate requires a name", () => {
  const bad = validateAssetCreate({});
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.name);

  const good = validateAssetCreate({ name: "Pool Pump" });
  assert.equal(good.valid, true);
});

test("validateAssetCreate rejects an unknown criticality but leaves it optional", () => {
  const unset = validateAssetCreate({ name: "Pool Pump" });
  assert.equal(unset.valid, true);

  const bad = validateAssetCreate({ name: "Pool Pump", criticality: "extreme" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.criticality);

  const good = validateAssetCreate({ name: "Pool Pump", criticality: "high" });
  assert.equal(good.valid, true);
});

test("buildAssetPayload trims name and omits unset optional fields", () => {
  const payload = buildAssetPayload({ name: "  Pool Pump  " });
  assert.deepEqual(payload, { name: "Pool Pump" });
});

test("buildAssetPayload includes optional fields when provided", () => {
  const payload = buildAssetPayload({
    name: "Pool Pump",
    assetTag: "PUMP-01",
    locationText: "Mechanical room",
    departmentId: "dept-1",
    category: "mechanical",
    criticality: "high",
    installDate: "2024-01-15",
    warrantyExpiresAt: "2026-01-15"
  });
  assert.equal(payload.asset_tag, "PUMP-01");
  assert.equal(payload.location_text, "Mechanical room");
  assert.equal(payload.department_id, "dept-1");
  assert.equal(payload.category, "mechanical");
  assert.equal(payload.criticality, "high");
  assert.equal(payload.install_date, "2024-01-15");
  assert.equal(payload.warranty_expires_at, "2026-01-15");
});

test("assetPickerOptions labels a tagged asset with its tag ahead of its name", () => {
  const options = assetPickerOptions([
    { id: "a1", name: "Pool Pump", asset_tag: "PUMP-01" },
    { id: "a2", name: "Ladder", asset_tag: null }
  ]);
  assert.deepEqual(options, [
    { value: "a1", label: "PUMP-01 — Pool Pump" },
    { value: "a2", label: "Ladder" }
  ]);
});

test("assetPickerOptions returns an empty list for no assets", () => {
  assert.deepEqual(assetPickerOptions(), []);
  assert.deepEqual(assetPickerOptions([]), []);
});

test("findAssetName returns the matching asset's name", () => {
  const assets = [{ id: "a1", name: "Pool Pump" }];
  assert.equal(findAssetName(assets, "a1"), "Pool Pump");
});

test("findAssetName returns null when the asset id is unset or not found", () => {
  const assets = [{ id: "a1", name: "Pool Pump" }];
  assert.equal(findAssetName(assets, null), null);
  assert.equal(findAssetName(assets, undefined), null);
  assert.equal(findAssetName(assets, "nope"), null);
  assert.equal(findAssetName([], "a1"), null);
});
