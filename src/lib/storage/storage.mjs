// Supabase Storage REST wrappers, mirroring src/lib/supabase-rest.mjs so the
// same client shape (client.url, client.key, client.authToken) works for both
// PostgREST and Storage calls against the same Supabase project.
//
// The Node server never handles multipart uploads: it issues a signed upload
// URL (POST .../object/upload/sign/{bucket}/{path}), the browser uploads
// directly to Supabase Storage with that URL/token, then the browser records
// the attachment row via the API. Downloads are served the same way, via a
// signed URL (POST .../object/sign/{bucket}/{path}).

export const DEFAULT_BUCKET = "attachments";

export class StorageError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.body = body;
  }
}

// Strips any directory components and disallowed characters from a filename
// so it is safe to append to a facility-scoped storage path. Deliberately has
// no randomness or timestamps -- callers that need a unique path do so by
// choosing a distinct filename/entityId, keeping this function deterministic.
function sanitizeFilename(filename) {
  const base = String(filename ?? "")
    .split(/[/\\]+/)
    .pop();
  const cleaned = (base ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "file";
}

// Builds a facility-scoped storage path: {facilityId}/{entity}/{entityId}/{sanitized-filename}.
export function facilityScopedPath(facilityId, entity, entityId, filename) {
  if (!facilityId) throw new Error("facilityScopedPath requires a facilityId");
  if (!entity) throw new Error("facilityScopedPath requires an entity");
  if (!entityId) throw new Error("facilityScopedPath requires an entityId");
  return `${facilityId}/${entity}/${entityId}/${sanitizeFilename(filename)}`;
}

function encodeStoragePath(path) {
  return String(path)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

function storageHeaders(client) {
  return {
    apikey: client.key,
    Authorization: `Bearer ${client.authToken ?? client.key}`,
    "Content-Type": "application/json"
  };
}

async function storageRequest(client, method, path, { body } = {}) {
  const response = await fetch(`${client.url}/storage/v1${path}`, {
    method,
    headers: storageHeaders(client),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new StorageError(`Supabase Storage ${method} ${path} failed with status ${response.status}`, {
      status: response.status,
      body: data
    });
  }
  return data;
}

// Requests a signed upload URL for a storage object. The client uploads
// directly to the returned url (with the returned token) via Supabase
// Storage's resumable/signed upload endpoint -- the Node server never sees
// the file bytes.
export async function signedUploadUrl(client, { bucket = DEFAULT_BUCKET, path } = {}) {
  if (!path) throw new Error("signedUploadUrl requires a path");
  const data = await storageRequest(client, "POST", `/object/upload/sign/${bucket}/${encodeStoragePath(path)}`);
  return { bucket, path, url: data?.url ?? null, token: data?.token ?? null };
}

// Requests a signed download URL for an existing storage object, valid for
// expiresIn seconds (default 1 hour).
export async function signedDownloadUrl(client, { bucket = DEFAULT_BUCKET, path, expiresIn = 3600 } = {}) {
  if (!path) throw new Error("signedDownloadUrl requires a path");
  const data = await storageRequest(client, "POST", `/object/sign/${bucket}/${encodeStoragePath(path)}`, {
    body: { expiresIn }
  });
  return { bucket, path, url: data?.signedURL ?? null, expiresIn };
}
