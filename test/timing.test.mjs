import test from "node:test";
import assert from "node:assert/strict";
import { elapsedMs } from "../src/lib/observability/timing.mjs";

test("elapsedMs converts a bigint hrtime delta to whole milliseconds", () => {
  assert.equal(elapsedMs(0n, 12_000_000n), 12);
  assert.equal(elapsedMs(1_000_000_000n, 1_034_500_000n), 34);
});

test("elapsedMs truncates sub-millisecond remainders", () => {
  assert.equal(elapsedMs(0n, 999_999n), 0);
  assert.equal(elapsedMs(0n, 1_999_999n), 1);
});

test("elapsedMs accepts plain numbers of nanoseconds", () => {
  assert.equal(elapsedMs(0, 5_000_000), 5);
});

test("elapsedMs clamps a negative or zero delta to 0", () => {
  assert.equal(elapsedMs(10n, 5n), 0);
  assert.equal(elapsedMs(10n, 10n), 0);
});
