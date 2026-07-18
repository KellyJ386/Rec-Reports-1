// Pure helper for turning a pair of process.hrtime.bigint() readings into a
// whole-millisecond duration. Accepts bigints (the real hrtime.bigint() type)
// or plain numbers of nanoseconds so it stays trivially unit-testable without
// touching process.hrtime from a test.
export function elapsedMs(startNs, endNs) {
  const start = typeof startNs === "bigint" ? startNs : BigInt(Math.trunc(startNs));
  const end = typeof endNs === "bigint" ? endNs : BigInt(Math.trunc(endNs));
  const deltaNs = end - start;
  if (deltaNs <= 0n) return 0;
  return Number(deltaNs / 1000000n);
}
