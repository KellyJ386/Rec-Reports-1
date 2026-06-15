import Dexie, { type Table } from "dexie";

/**
 * Offline store (CLAUDE.md §8). Documentation modules (reports, tasks, log, forms)
 * capture offline and sync on reconnect. Scheduling publish and cert enforcement require
 * connectivity and are NOT queued here.
 *
 * Conflict policy: editable records use last-write-wins **with a conflict flag surfaced to
 * a manager** — never a silent overwrite. See `conflicts` table and lib/offline/sync-queue.
 */

export type SyncStatus = "pending" | "syncing" | "synced" | "error" | "conflict";

/** A queued mutation awaiting replay against the server. */
export interface QueuedMutation {
  /** client_mutation_id — idempotency key (CLAUDE.md §7 / Module Spec). */
  id: string;
  entity: string; // e.g. "injury_report", "task"
  op: "insert" | "update" | "delete";
  facilityId: string; // resolved when queued; server re-validates membership
  payload: unknown;
  /** version the edit was based on; used to detect a concurrent server change. */
  baseVersion: number | null;
  status: SyncStatus;
  retryCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Locally cached reference/config data for offline form rendering. */
export interface CachedEntity {
  key: string; // `${entity}:${id}` or `${entity}:list:${facilityId}`
  facilityId: string;
  entity: string;
  data: unknown;
  version: number;
  cachedAt: number;
}

/** A draft a user is editing offline (autosave target). */
export interface FormDraft {
  id: string;
  entity: string;
  facilityId: string;
  data: unknown;
  updatedAt: number;
}

/**
 * A surfaced conflict: the queued (losing) write is preserved here for manager review
 * instead of being silently discarded (CLAUDE.md §8).
 */
export interface ConflictRecord {
  id: string; // = the QueuedMutation id
  entity: string;
  facilityId: string;
  localPayload: unknown;
  serverPayload: unknown;
  baseVersion: number | null;
  serverVersion: number | null;
  detectedAt: number;
  resolved: boolean;
}

export class RecReportsDB extends Dexie {
  mutations!: Table<QueuedMutation, string>;
  cache!: Table<CachedEntity, string>;
  drafts!: Table<FormDraft, string>;
  conflicts!: Table<ConflictRecord, string>;

  constructor() {
    super("recreports");
    this.version(1).stores({
      mutations: "id, status, entity, facilityId, createdAt",
      cache: "key, facilityId, entity",
      drafts: "id, entity, facilityId, updatedAt",
      // `resolved` is boolean (not IndexedDB-indexable) — query it via filter().
      conflicts: "id, facilityId, detectedAt",
    });
  }
}

let _db: RecReportsDB | null = null;

/** Lazily construct the DB only in the browser (Dexie needs IndexedDB). */
export function getDB(): RecReportsDB {
  if (typeof window === "undefined") {
    throw new Error("Offline DB is browser-only");
  }
  _db ??= new RecReportsDB();
  return _db;
}
