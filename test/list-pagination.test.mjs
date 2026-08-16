import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/public/js/list-pagination.mjs";

test("paginate slices the first page by default", () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const result = paginate(items, 1, 5);
  assert.deepEqual(result.pageItems, [0, 1, 2, 3, 4]);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 3);
  assert.equal(result.total, 12);
  assert.equal(result.hasPrev, false);
  assert.equal(result.hasNext, true);
});

test("paginate returns the trailing partial page", () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const result = paginate(items, 3, 5);
  assert.deepEqual(result.pageItems, [10, 11]);
  assert.equal(result.hasPrev, true);
  assert.equal(result.hasNext, false);
});

test("paginate clamps an out-of-range page to the last page", () => {
  const items = Array.from({ length: 3 }, (_, i) => i);
  const result = paginate(items, 99, 5);
  assert.equal(result.page, 1);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.pageItems, [0, 1, 2]);
});

test("paginate clamps a page below 1 up to 1", () => {
  const items = [1, 2, 3];
  const result = paginate(items, 0, 2);
  assert.equal(result.page, 1);
  assert.deepEqual(result.pageItems, [1, 2]);
});

test("paginate handles an empty list without throwing", () => {
  const result = paginate([], 1, 5);
  assert.deepEqual(result.pageItems, []);
  assert.equal(result.totalPages, 1);
  assert.equal(result.hasPrev, false);
  assert.equal(result.hasNext, false);
});

test("paginate tolerates a non-array input", () => {
  const result = paginate(null, 1, 5);
  assert.deepEqual(result.pageItems, []);
  assert.equal(result.total, 0);
});

test("paginate floors a non-integer pageSize to at least 1", () => {
  const items = [1, 2, 3, 4];
  const result = paginate(items, 1, 0);
  assert.equal(result.pageSize, 1);
  assert.equal(result.totalPages, 4);
});
