import { getDB, type QueuedMutation } from "./db";

/**
 * Generic offline sync queue (CLAUDE.md §8).
 *
 *   1. optimistic local write -> enqueue()
 *   2. background replay with exponential backoff -> processQueue()
 *   3. server returns canonical row + version
 *   4. on a concurrent server change -> flag a conflict (NEVER silent overwrite)
 *
 * Each module injects a `MutationHandler` that knows how to replay its entity against the
 * appropriate Server Action / Route Handler. The handler must be idempotent on
 * `mutation.id` (the client_mutation_id) so retries are safe.
 */

export type ReplayResult =
  | { kind: "ok"; serverVersion: number | null }
  | {
      kind: "conflict";
      serverVersion: number | null;
      serverPayload: unknown;
    };

export type MutationHandler = (mutation: QueuedMutation) => Promise<ReplayResult>;

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;

function backoffDelay(retryCount: number): number {
  // 1s, 2s, 4s, 8s, … capped at 30s
  return Math.min(BASE_DELAY_MS * 2 ** retryCount, 30_000);
}

/** Enqueue a mutation after an optimistic local write. Returns the client_mutation_id. */
export async function enqueue(
  input: Omit<
    QueuedMutation,
    "status" | "retryCount" | "createdAt" | "updatedAt"
  >,
): Promise<string> {
  const db = getDB();
  const now = Date.now();
  const mutation: QueuedMutation = {
    ...input,
    status: "pending",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.mutations.put(mutation);
  return mutation.id;
}

/**
 * Drain the queue once. Call on reconnect and on an interval. Returns counts so the UI
 * can reflect progress.
 */
export async function processQueue(
  handlers: Record<string, MutationHandler>,
): Promise<{ synced: number; conflicts: number; errors: number }> {
  const db = getDB();
  let synced = 0;
  let conflicts = 0;
  let errors = 0;

  const pending = await db.mutations
    .where("status")
    .anyOf("pending", "error")
    .sortBy("createdAt");

  for (const mutation of pending) {
    const handler = handlers[mutation.entity];
    if (!handler) continue; // no handler registered for this entity yet

    // Respect backoff for previously errored items.
    if (
      mutation.status === "error" &&
      Date.now() - mutation.updatedAt < backoffDelay(mutation.retryCount)
    ) {
      continue;
    }

    await db.mutations.update(mutation.id, {
      status: "syncing",
      updatedAt: Date.now(),
    });

    try {
      const result = await handler(mutation);

      if (result.kind === "ok") {
        await db.mutations.update(mutation.id, {
          status: "synced",
          updatedAt: Date.now(),
        });
        synced++;
      } else {
        // Concurrent server change. Preserve the losing write for manager review
        // instead of overwriting (CLAUDE.md §8 — never a silent overwrite).
        await db.transaction("rw", db.mutations, db.conflicts, async () => {
          await db.conflicts.put({
            id: mutation.id,
            entity: mutation.entity,
            facilityId: mutation.facilityId,
            localPayload: mutation.payload,
            serverPayload: result.serverPayload,
            baseVersion: mutation.baseVersion,
            serverVersion: result.serverVersion,
            detectedAt: Date.now(),
            resolved: false,
          });
          await db.mutations.update(mutation.id, {
            status: "conflict",
            updatedAt: Date.now(),
          });
        });
        conflicts++;
      }
    } catch (err) {
      const retryCount = mutation.retryCount + 1;
      await db.mutations.update(mutation.id, {
        status: retryCount >= MAX_RETRIES ? "error" : "pending",
        retryCount,
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
      errors++;
    }
  }

  return { synced, conflicts, errors };
}

/** Counts for the sync-status indicator. */
export async function queueCounts() {
  const db = getDB();
  const [pending, conflicts, errors] = await Promise.all([
    db.mutations.where("status").anyOf("pending", "syncing").count(),
    // `resolved` is a boolean (not IndexedDB-indexable) — filter in memory.
    db.conflicts.filter((c) => !c.resolved).count(),
    db.mutations.where("status").equals("error").count(),
  ]);
  return { pending, conflicts, errors };
}
