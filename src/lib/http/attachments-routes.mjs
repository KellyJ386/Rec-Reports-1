import { createHash } from "node:crypto";
import { pgSelect, pgInsert } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import {
  createStorageClientFromEnv,
  buildAttachmentPath,
  assertMimeAllowed,
  assertWithinSizeCap,
  uploadObject,
  createSignedUrl,
  DEFAULT_MAX_UPLOAD_BYTES
} from "../storage.mjs";

// Attachment routes for the three modules that grew storage columns without
// I/O in 0002/0004/0005 (OP-15/16 landed the bucket + client; this is OP-17,
// the BFF-proxied upload/list/download surface on top of them).
//
// Every module follows the same shape:
//   POST   /<segment>/:id/attachments              -- raw binary upload
//   GET    /<segment>/:id/attachments               -- list metadata rows
//   GET    /<segment>/attachments/:attachmentId/url -- short-TTL signed URL
//
// The table below is the single source of truth for how each module's
// module-specific bits (parent table, attachment table + columns, storage
// path segment, permission codes, row-shaping) differ; the route
// registration loop at the bottom is identical for all three.

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

// Thrown by readRawBody when the request body (declared or actual) exceeds
// the per-route cap -- distinct from StorageValidationError (which covers
// mime/size/path shape problems that never touch the network) so the route
// handler can map it to 413 without inspecting error.code.
export class UploadTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadTooLargeError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// A StorageValidationError's `code` decides the HTTP status: only
// "file_too_large" is a 413, everything else (bad mime, unsafe path
// segments, empty/invalid filename) is a 400 shape problem.
function storageErrorStatus(error) {
  return error.code === "file_too_large" ? 413 : 400;
}

// Reads the declared Content-Length header, if any, as a plain number
// (no I/O) so an oversize upload can 413 before the parent row is even
// loaded -- mirrors this codebase's "validate shape before guarding, zero
// fetches on failure" convention used by every other route module.
function declaredContentLength(request) {
  const header = request.headers?.["content-length"];
  if (header === undefined || header === null || header === "") return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

// Reads the raw request body into a Buffer, enforcing maxBytes as data
// arrives -- the actual-bytes-received backstop behind declaredContentLength
// above (a client can omit or lie about Content-Length; chunked transfer
// encodings have none at all). Shaped exactly like scripts/server.mjs's
// readBody (data/end/error events, destroy-on-overflow) but returns a
// Buffer instead of a utf8 string, since attachment bytes are never JSON.
function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        if (typeof request.destroy === "function") request.destroy();
        reject(new UploadTooLargeError(`request body exceeds the ${maxBytes}-byte cap`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

// --- Module table map --------------------------------------------------
// facility_id/status are always selected on the parent row regardless of
// module (every one of report_submissions/incident_reports/work_orders has
// both columns), so loadParent below needs no per-module select override.

const MODULES = {
  reports: {
    urlSegment: "reports",
    storageModule: "reports",
    parentTable: "report_submissions",
    parentLabel: "report",
    readPermission: "reports.read",
    // Adding an attachment to a submission is an edit of that draft, not the
    // creation of a new one -- gated the same as PATCH /reports/:id and the
    // RLS "report submitters can update drafts" policy (0002/0009/0026),
    // both of which require reports.submit + status = 'draft', not
    // reports.create (that code only ever gates the initial POST that
    // creates the submission row itself).
    writePermission: "reports.submit",
    attachmentTable: "report_submission_attachments",
    attachmentParentColumn: "submission_id",
    attachmentColumns: "id,facility_id,submission_id,field_key,storage_path,mime_type,checksum,metadata,created_at",
    // DR-09 nuance: a submission stops accepting new attachments once it
    // leaves draft (submitted/locked/revised are immutable, same as the
    // PATCH /reports/:id edit gate in reports-routes.mjs).
    enforceDraftOnUpload: true,
    buildAttachmentRow({ parent, path, contentType, checksum, fieldKey }) {
      return {
        facility_id: parent.facility_id,
        submission_id: parent.id,
        field_key: fieldKey || "attachment",
        storage_path: path,
        mime_type: contentType,
        checksum,
        metadata: {}
      };
    }
  },
  incidents: {
    urlSegment: "incidents",
    storageModule: "incidents",
    parentTable: "incident_reports",
    parentLabel: "incident",
    readPermission: "incidents.read",
    writePermission: "incidents.manage",
    attachmentTable: "incident_attachments",
    attachmentParentColumn: "incident_id",
    attachmentColumns:
      "id,facility_id,incident_id,attachment_type,storage_path,captured_at,captured_by,checksum_sha256,metadata,created_at",
    enforceDraftOnUpload: false,
    buildAttachmentRow({ parent, path, contentType, checksum, auth }) {
      return {
        facility_id: parent.facility_id,
        incident_id: parent.id,
        // incident_attachments.attachment_type is a NOT NULL check
        // ('photo'|'document'|'video'|'audio'); the default upload mime
        // allow-list (storage.mjs) only ever admits images or PDFs, so this
        // binary split covers every content type that can reach here.
        attachment_type: contentType.startsWith("image/") ? "photo" : "document",
        storage_path: path,
        captured_at: nowIso(),
        captured_by: auth.claims.sub,
        checksum_sha256: checksum,
        metadata: {}
      };
    }
  },
  "work-orders": {
    urlSegment: "work-orders",
    storageModule: "work_orders",
    parentTable: "work_orders",
    parentLabel: "work order",
    readPermission: "work_orders.read",
    writePermission: "work_orders.manage",
    attachmentTable: "work_order_attachments",
    attachmentParentColumn: "work_order_id",
    attachmentColumns: "id,facility_id,work_order_id,storage_path,mime_type,checksum,metadata,created_by,created_at",
    enforceDraftOnUpload: false,
    buildAttachmentRow({ parent, path, contentType, checksum, auth }) {
      return {
        facility_id: parent.facility_id,
        work_order_id: parent.id,
        storage_path: path,
        mime_type: contentType,
        checksum,
        metadata: {},
        created_by: auth.claims.sub
      };
    }
  }
};

// Registers the attachment routes for all three modules above on `router`.
// Injected primitives, same shape as the other route modules plus one
// storage-specific addition:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   createStorageClient(env) -> storage client (see src/lib/storage.mjs);
//     defaults to createStorageClientFromEnv(env) -- tests inject a stub
//     client with a fake fetchImpl instead of hitting real Storage REST.
//
// Deliberately does NOT take `readBody`: every route here either has no
// body (the two GETs) or a raw-binary one (the POST), read directly off the
// request stream by readRawBody above -- readBody's JSON-only parsing and
// 1 MB cap (scripts/server.mjs) don't fit either case.
export function registerAttachmentRoutes(router, deps) {
  const { authenticate, sendJson, createStorageClient = (env) => createStorageClientFromEnv(env) } = deps;

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  // notFoundOnDeny: the signed-url route isn't nested under a known parent,
  // so a caller with no access to the attachment's facility gets 404 rather
  // than 403 -- otherwise the response itself would confirm a foreign
  // attachment id exists. Every other route in this file keeps the normal
  // 403-on-deny convention used across the rest of the codebase.
  function requirePerm(auth, facilityId, code, response, { notFoundOnDeny = false } = {}) {
    const guard = requireAuthPermission(auth, facilityId, code);
    if (!guard.allowed) {
      sendJson(
        response,
        notFoundOnDeny ? 404 : 403,
        notFoundOnDeny ? { error: "attachment not found" } : { error: guard.reason }
      );
      return false;
    }
    return true;
  }

  async function loadParent(client, config, id) {
    const rows = await pgSelect(client, config.parentTable, {
      filters: { id },
      select: "id,facility_id,status",
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadAttachment(client, config, id) {
    const rows = await pgSelect(client, config.attachmentTable, {
      filters: { id },
      select: config.attachmentColumns,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // A percent-encoded x-file-name (recommended for the browser client,
  // since fetch's Headers API rejects non-Latin1 header values) is decoded
  // here; a plain ASCII filename with no "%" round-trips through
  // decodeURIComponent unchanged, so this is safe either way. A malformed
  // percent-encoding just falls back to the raw header value -- sanitizeFilename
  // (called inside buildAttachmentPath below) rejects/cleans whatever comes out.
  function decodeFilenameHeader(rawHeader) {
    try {
      return decodeURIComponent(rawHeader);
    } catch {
      return rawHeader;
    }
  }

  for (const config of Object.values(MODULES)) {
    // --- POST /<segment>/:id/attachments -----------------------------------
    // Raw binary upload proxied through the BFF. Order: shape-only checks
    // (mime, filename header, declared Content-Length) with zero I/O first;
    // then load the parent and guard write permission on ITS facility_id
    // (never a client-supplied one); then (reports only) the draft-only
    // gate; only then is the body actually read off the socket, streaming
    // through readRawBody's own byte-count cap as a backstop against a
    // missing/understated Content-Length. storage_path, mime_type, and the
    // sha256 checksum are always server-derived -- never taken from the
    // client beyond the raw bytes and the filename hint.
    router.register("POST", `/${config.urlSegment}/:id/attachments`, (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        let contentType;
        try {
          contentType = assertMimeAllowed(request.headers["content-type"]);
        } catch (error) {
          return sendJson(response, storageErrorStatus(error), { error: error.message, code: error.code });
        }

        const filenameHeader = request.headers["x-file-name"];
        if (!filenameHeader) {
          return sendJson(response, 400, { error: "x-file-name header is required" });
        }

        const declaredLength = declaredContentLength(request);
        if (declaredLength !== null && declaredLength > DEFAULT_MAX_UPLOAD_BYTES) {
          if (typeof request.destroy === "function") request.destroy();
          return sendJson(response, 413, {
            error: `request body of ${declaredLength} bytes exceeds the ${DEFAULT_MAX_UPLOAD_BYTES}-byte cap`
          });
        }

        const parent = await loadParent(auth.client, config, params.id);
        if (!parent) return sendJson(response, 404, { error: `${config.parentLabel} not found` });
        if (!requirePerm(auth, parent.facility_id, config.writePermission, response)) return;
        if (config.enforceDraftOnUpload && parent.status !== "draft") {
          return sendJson(response, 409, { error: `attachments can only be added to a draft ${config.parentLabel}` });
        }

        let bodyBuffer;
        try {
          bodyBuffer = await readRawBody(request, DEFAULT_MAX_UPLOAD_BYTES);
        } catch (error) {
          if (error instanceof UploadTooLargeError) return sendJson(response, 413, { error: error.message });
          return sendJson(response, 400, { error: "failed to read request body" });
        }

        try {
          assertWithinSizeCap(bodyBuffer.length);
        } catch (error) {
          return sendJson(response, storageErrorStatus(error), { error: error.message, code: error.code });
        }
        if (bodyBuffer.length === 0) {
          return sendJson(response, 400, { error: "request body is empty" });
        }

        const filename = decodeFilenameHeader(filenameHeader);
        let path;
        try {
          path = buildAttachmentPath(parent.facility_id, config.storageModule, parent.id, filename);
        } catch (error) {
          return sendJson(response, 400, { error: error.message, code: error.code });
        }

        const checksum = sha256Hex(bodyBuffer);
        const storageClient = createStorageClient(env);
        try {
          await uploadObject(storageClient, { path, body: bodyBuffer, contentType });
        } catch {
          return sendJson(response, 502, { error: "storage upload failed" });
        }

        const row = config.buildAttachmentRow({
          parent,
          path,
          contentType,
          checksum,
          auth,
          fieldKey: request.headers["x-field-key"]
        });
        const rows = await pgInsert(auth.client, config.attachmentTable, [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
    );

    // --- GET /<segment>/:id/attachments -------------------------------------
    // Lists metadata rows for the parent. Read-only: not gated on the
    // reports draft-only rule (evidence stays visible after submit).
    router.register("GET", `/${config.urlSegment}/:id/attachments`, (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const parent = await loadParent(auth.client, config, params.id);
        if (!parent) return sendJson(response, 404, { error: `${config.parentLabel} not found` });
        if (!requirePerm(auth, parent.facility_id, config.readPermission, response)) return;
        const rows = await pgSelect(auth.client, config.attachmentTable, {
          filters: { [config.attachmentParentColumn]: parent.id },
          select: config.attachmentColumns,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
    );

    // --- GET /<segment>/attachments/:attachmentId/url -----------------------
    // Short-TTL signed URL. Loads the attachment row directly (it already
    // carries facility_id, so no parent lookup is needed) and 404s -- not
    // 403s -- when the caller can't read that facility, per the doc comment
    // on requirePerm above.
    router.register(
      "GET",
      `/${config.urlSegment}/attachments/:attachmentId/url`,
      (request, response, { env, params }) =>
        withAuth(request, response, env, async (auth) => {
          const attachment = await loadAttachment(auth.client, config, params.attachmentId);
          if (!attachment) return sendJson(response, 404, { error: "attachment not found" });
          if (!requirePerm(auth, attachment.facility_id, config.readPermission, response, { notFoundOnDeny: true })) {
            return;
          }
          const storageClient = createStorageClient(env);
          try {
            const url = await createSignedUrl(storageClient, attachment.storage_path, DEFAULT_SIGNED_URL_TTL_SECONDS);
            return sendJson(response, 200, { url, expiresInSeconds: DEFAULT_SIGNED_URL_TTL_SECONDS });
          } catch {
            return sendJson(response, 502, { error: "failed to create signed url" });
          }
        })
    );
  }

  return router;
}
