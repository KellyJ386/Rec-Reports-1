// Platform file-storage primitive (OP-16). Talks to the Supabase Storage
// REST API over native `fetch` with the service-role key -- zero runtime
// dependencies, same convention as src/lib/supabase-rest.mjs. Every module
// that grows attachments (reports, incidents, work orders, training) is
// meant to sit on top of this one file rather than each rolling its own
// upload/path/signing logic.
//
// All network I/O goes through an injectable `fetchImpl` captured on the
// client object returned by createStorageClient (defaulting to the global
// fetch), so tests can stub it without touching globalThis -- unlike
// supabase-rest.mjs, which is exercised by monkeypatching globalThis.fetch.
//
// Defense-in-depth note: the RLS policies in supabase/migrations/0030_storage.sql
// only ever grant SELECT, and only for paths under the caller's own
// facility_id -- normal reads and every write go through this client with
// the service role, which bypasses RLS entirely. buildAttachmentPath's
// "facilities/{facilityId}/..." shape is exactly what those policies parse.

export class StorageValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StorageValidationError";
    this.code = code;
  }
}

export class StorageRequestError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "StorageRequestError";
    this.status = status;
    this.body = body;
  }
}

// --- Client -----------------------------------------------------------------

export function createStorageClient({ url, key, bucket = "attachments", fetchImpl } = {}) {
  if (!url) throw new Error("createStorageClient requires a url");
  if (!key) throw new Error("createStorageClient requires a key (service role key)");
  if (!bucket) throw new Error("createStorageClient requires a bucket");
  return {
    url: String(url).replace(/\/+$/, ""),
    key,
    bucket,
    fetchImpl: fetchImpl ?? fetch
  };
}

// Convenience factory for the common case: build a client straight from the
// server env (see src/lib/env.mjs -- SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_STORAGE_BUCKET). Callers that already have a client (e.g. tests)
// can skip this and call createStorageClient directly.
export function createStorageClientFromEnv(serverEnv, { fetchImpl } = {}) {
  if (!serverEnv?.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("createStorageClientFromEnv requires SUPABASE_SERVICE_ROLE_KEY on the server env");
  }
  return createStorageClient({
    url: serverEnv.SUPABASE_URL,
    key: serverEnv.SUPABASE_SERVICE_ROLE_KEY,
    bucket: serverEnv.SUPABASE_STORAGE_BUCKET ?? "attachments",
    fetchImpl
  });
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function encodeObjectPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function storageFetch(client, method, subpath, { body, headers } = {}) {
  const response = await client.fetchImpl(`${client.url}/storage/v1${subpath}`, {
    method,
    headers: {
      apikey: client.key,
      Authorization: `Bearer ${client.key}`,
      ...headers
    },
    body
  });
  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw new StorageRequestError(`Supabase Storage ${method} ${subpath} failed with status ${response.status}`, {
      status: response.status,
      body: data
    });
  }
  return data;
}

// --- Path safety --------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Module/record path segments: alnum plus internal "-"/"_", 1-64 chars, no
// leading/trailing separator -- deliberately excludes "/", "\", "." so a
// segment can never smuggle in a traversal or extra path level.
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const MAX_FILENAME_LENGTH = 180;

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new StorageValidationError(`${label} must be a UUID.`, "invalid_id");
  }
  return value.toLowerCase();
}

function assertSafeSegment(value, label) {
  if (typeof value !== "string" || !SAFE_SEGMENT_PATTERN.test(value)) {
    throw new StorageValidationError(`${label} contains unsafe characters: ${JSON.stringify(value)}`, "invalid_id");
  }
  return value;
}

// Sanitizes a user-supplied filename for use as the tail segment of an
// attachment path.
//
// Two different failure modes, on purpose:
//   - Traversal/control-character attempts ("../", "/", "\", ".."
//     anywhere, null bytes and other control chars) are REJECTED outright
//     (throws) -- these are attack signals, not formatting to clean up.
//   - Everything else "odd" (spaces, unicode, punctuation outside
//     [A-Za-z0-9._-]) is SANITIZED: folded to "-", repeats collapsed, and
//     stray leading/trailing "-"/"." trimmed.
export function sanitizeFilename(rawFilename) {
  if (typeof rawFilename !== "string" || rawFilename.length === 0) {
    throw new StorageValidationError("filename is required.", "invalid_filename");
  }
  if (hasControlCharacters(rawFilename)) {
    throw new StorageValidationError(
      `filename contains control characters: ${JSON.stringify(rawFilename)}`,
      "invalid_filename"
    );
  }
  if (rawFilename.includes("/") || rawFilename.includes("\\") || rawFilename.includes("..")) {
    throw new StorageValidationError(
      `filename must not contain path separators or "..": ${JSON.stringify(rawFilename)}`,
      "path_traversal"
    );
  }

  const trimmed = rawFilename.normalize("NFKC").trim();
  if (trimmed.length === 0 || trimmed === ".") {
    throw new StorageValidationError(`filename is not valid: ${JSON.stringify(rawFilename)}`, "invalid_filename");
  }

  let safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
  safe = safe.replace(/-{2,}/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  if (safe.length === 0) {
    throw new StorageValidationError(`filename sanitizes to an empty name: ${JSON.stringify(rawFilename)}`, "invalid_filename");
  }

  if (safe.length > MAX_FILENAME_LENGTH) {
    const dot = safe.lastIndexOf(".");
    const hasShortExtension = dot > 0 && safe.length - dot <= 12;
    const extension = hasShortExtension ? safe.slice(dot) : "";
    const base = hasShortExtension ? safe.slice(0, dot) : safe;
    safe = base.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
  }

  return safe;
}

// Builds the canonical object path for an attachment:
//   facilities/{facilityId}/{module}/{recordId}/{uuid}-{safeName}
//
// facilityId must be a UUID (it is what the storage.objects RLS policy in
// 0030_storage.sql parses back out to compare against current_facility_ids()).
// module/recordId are restricted to a safe charset. filename is sanitized
// per sanitizeFilename above. A fresh random UUID is always prepended to the
// final segment so two uploads of the same filename never collide.
export function buildAttachmentPath(facilityId, module, recordId, filename) {
  const safeFacilityId = assertUuid(facilityId, "facilityId");
  const safeModule = assertSafeSegment(module, "module");
  const safeRecordId = assertSafeSegment(recordId, "recordId");
  const safeName = sanitizeFilename(filename);
  const uniqueId = crypto.randomUUID();
  return `facilities/${safeFacilityId}/${safeModule}/${safeRecordId}/${uniqueId}-${safeName}`;
}

// --- Mime allow-list + size cap ---------------------------------------------

export const DEFAULT_ALLOWED_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf"
]);

export const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB

export function assertMimeAllowed(contentType, allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES) {
  const normalized = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
  const allowList = (allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES).map((type) => type.toLowerCase());
  if (!normalized || !allowList.includes(normalized)) {
    throw new StorageValidationError(`content type not allowed: ${contentType}`, "mime_not_allowed");
  }
  return normalized;
}

export function assertWithinSizeCap(sizeBytes, maxBytes = DEFAULT_MAX_UPLOAD_BYTES) {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new StorageValidationError(`size must be a non-negative number: ${sizeBytes}`, "invalid_size");
  }
  if (sizeBytes > maxBytes) {
    throw new StorageValidationError(`file is ${sizeBytes} bytes, over the ${maxBytes}-byte cap.`, "file_too_large");
  }
  return sizeBytes;
}

// Convenience wrapper running both checks together (mime first, then size),
// for callers that want a single guard before accepting an upload.
export function assertUploadAllowed({ contentType, size, allowedMimeTypes, maxBytes } = {}) {
  assertMimeAllowed(contentType, allowedMimeTypes);
  assertWithinSizeCap(size, maxBytes);
}

// --- Storage REST operations -------------------------------------------

// Uploads a single object. `body` is whatever the injected fetch accepts as
// a body (Buffer/Uint8Array/string/Blob); this module never buffers/streams
// it itself. `upsert: true` overwrites an existing object at `path` instead
// of failing -- default false, since buildAttachmentPath's random uuid
// prefix means collisions should never legitimately happen.
export async function uploadObject(client, { path, body, contentType, upsert = false, cacheControl = "3600" } = {}) {
  if (!path) throw new StorageValidationError("path is required.", "invalid_path");
  if (body === undefined || body === null) {
    throw new StorageValidationError("body is required.", "invalid_body");
  }
  const headers = {
    "Content-Type": contentType ?? "application/octet-stream",
    "x-upsert": upsert ? "true" : "false"
  };
  if (cacheControl) headers["cache-control"] = cacheControl;
  return storageFetch(client, "POST", `/object/${client.bucket}/${encodeObjectPath(path)}`, { body, headers });
}

// Requests a short-lived signed URL for reading `path`. `ttlSeconds` must be
// a positive integer (Storage's `expiresIn`, in seconds).
export async function createSignedUrl(client, path, ttlSeconds) {
  if (!path) throw new StorageValidationError("path is required.", "invalid_path");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new StorageValidationError(`ttlSeconds must be a positive integer: ${ttlSeconds}`, "invalid_ttl");
  }
  const data = await storageFetch(client, "POST", `/object/sign/${client.bucket}/${encodeObjectPath(path)}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: ttlSeconds })
  });
  const signedPath = data?.signedURL ?? data?.signedUrl;
  if (!signedPath) {
    throw new StorageRequestError("Supabase Storage sign response is missing signedURL.", { status: 502, body: data });
  }
  return `${client.url}/storage/v1${signedPath}`;
}

// Deletes a single object via the bulk-remove endpoint (the only delete
// endpoint the Storage REST API documents), sending `path` as the lone
// entry in `prefixes`.
export async function deleteObject(client, path) {
  if (!path) throw new StorageValidationError("path is required.", "invalid_path");
  return storageFetch(client, "DELETE", `/object/${client.bucket}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [path] })
  });
}
