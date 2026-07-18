import { pgSelect, pgInsert } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";
import { facilityScopedPath, signedUploadUrl, signedDownloadUrl, DEFAULT_BUCKET } from "../storage/storage.mjs";

const ATTACHMENT_TYPES = ["photo", "document", "video", "audio"];

const REPORT_ATTACHMENT_COLUMNS =
  "id,facility_id,submission_id,field_key,storage_path,mime_type,checksum,metadata,created_at";
const INCIDENT_ATTACHMENT_COLUMNS =
  "id,facility_id,incident_id,attachment_type,storage_path,captured_at,captured_by,checksum_sha256," +
  "metadata,created_at";
const WORK_ORDER_ATTACHMENT_COLUMNS =
  "id,facility_id,work_order_id,storage_path,mime_type,checksum,metadata,created_by,created_at";

// Registers the file-storage (Supabase Storage) attachment routes for the
// three entities that have attachment tables: report submissions, incidents,
// and work orders. Uses the same injected-primitives shape as the other
// end-user route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Follows the signed-URL pattern so this server never handles multipart
// uploads:
//   1. POST .../attachments/sign  -> issues a signed upload URL + the
//      storage_path the client must record.
//   2. The client uploads the file bytes directly to Supabase Storage.
//   3. POST .../attachments       -> records the attachment row.
//   4. GET  /<entity>-attachments/:id/download -> issues a signed download URL.
export function registerAttachmentRoutes(router, { authenticate, sendJson, readBody }) {
  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  function requirePerm(auth, facilityId, code, response) {
    const guard = requireAuthPermission(auth, facilityId, code);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  // Validates the minimal sign-request body {filename, mimeType}. Returns the
  // list of shape errors (empty when valid).
  function validateSignBody(payload) {
    const errors = [];
    if (!isNonEmptyString(payload.filename)) errors.push("filename is required");
    if (!isNonEmptyString(payload.mimeType)) errors.push("mimeType is required");
    return errors;
  }

  async function loadAttachment(client, table, columns, id) {
    const rows = await pgSelect(client, table, { filters: { id }, select: columns, limit: 1 });
    return (rows ?? [])[0] ?? null;
  }

  // Registers the sign / record / download triplet for one attachment entity.
  //   entitySegment: URL segment under /facilities/:facilityId/<entitySegment>/:entityParam
  //   entityParam:   route param name for the parent entity id (e.g. "submissionId")
  //   downloadPrefix: URL prefix for the standalone download route (e.g. "report")
  //   permission:    the manage/create permission code required to sign + record
  //   readPermission: the read permission code required to download
  //   table/columns: the attachments table and its select column list
  //   buildInsertRow(params, body, auth): shapes the row to insert
  function registerEntity(router, {
    entitySegment,
    entityParam,
    downloadPrefix,
    permission,
    readPermission,
    storageEntity,
    table,
    columns,
    buildInsertRow
  }) {
    router.register(
      "POST",
      `/facilities/:facilityId/${entitySegment}/:${entityParam}/attachments/sign`,
      (request, response, { env, params }) =>
        withAuth(request, response, env, async (auth) => {
          const body = await parseJsonBody(request);
          if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
          const errors = validateSignBody(body.payload);
          if (errors.length > 0) return sendJson(response, 400, { errors });
          if (!requirePerm(auth, params.facilityId, permission, response)) return;

          const path = facilityScopedPath(
            params.facilityId,
            storageEntity,
            params[entityParam],
            body.payload.filename
          );
          const signed = await signedUploadUrl(auth.client, { bucket: DEFAULT_BUCKET, path });
          return sendJson(response, 200, {
            bucket: signed.bucket,
            path: signed.path,
            uploadUrl: signed.url,
            token: signed.token
          });
        })
    );

    router.register(
      "POST",
      `/facilities/:facilityId/${entitySegment}/:${entityParam}/attachments`,
      (request, response, { env, params }) =>
        withAuth(request, response, env, async (auth) => {
          const body = await parseJsonBody(request);
          if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
          const { row, errors } = buildInsertRow(params, body.payload, auth);
          if (errors.length > 0) return sendJson(response, 400, { errors });
          if (!requirePerm(auth, params.facilityId, permission, response)) return;

          const rows = await pgInsert(auth.client, table, [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        })
    );

    router.register("GET", `/${downloadPrefix}-attachments/:id/download`, (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const attachment = await loadAttachment(auth.client, table, columns, params.id);
        if (!attachment) return sendJson(response, 404, { error: "attachment not found" });
        if (!requirePerm(auth, attachment.facility_id, readPermission, response)) return;

        const signed = await signedDownloadUrl(auth.client, {
          bucket: DEFAULT_BUCKET,
          path: attachment.storage_path
        });
        return sendJson(response, 200, { url: signed.url, expiresIn: signed.expiresIn, path: signed.path });
      })
    );
  }

  // --- Report submission attachments (report_submission_attachments) --------
  registerEntity(router, {
    entitySegment: "reports",
    entityParam: "submissionId",
    downloadPrefix: "report",
    permission: "reports.create",
    readPermission: "reports.read",
    storageEntity: "reports",
    table: "report_submission_attachments",
    columns: REPORT_ATTACHMENT_COLUMNS,
    buildInsertRow(params, payload, auth) {
      const errors = [];
      if (!isNonEmptyString(payload.fieldKey)) errors.push("fieldKey is required");
      if (!isNonEmptyString(payload.storagePath)) errors.push("storagePath is required");
      if (!isNonEmptyString(payload.mimeType)) errors.push("mimeType is required");
      const row = {
        facility_id: params.facilityId,
        submission_id: params.submissionId,
        field_key: payload.fieldKey,
        storage_path: payload.storagePath,
        mime_type: payload.mimeType,
        checksum: payload.checksum ?? null,
        metadata: payload.metadata ?? {}
      };
      return { row, errors };
    }
  });

  // --- Incident attachments (incident_attachments) ---------------------------
  registerEntity(router, {
    entitySegment: "incidents",
    entityParam: "incidentId",
    downloadPrefix: "incident",
    permission: "incidents.manage",
    readPermission: "incidents.read",
    storageEntity: "incidents",
    table: "incident_attachments",
    columns: INCIDENT_ATTACHMENT_COLUMNS,
    buildInsertRow(params, payload, auth) {
      const errors = [];
      if (!ATTACHMENT_TYPES.includes(payload.attachmentType)) {
        errors.push(`attachmentType must be one of: ${ATTACHMENT_TYPES.join(", ")}`);
      }
      if (!isNonEmptyString(payload.storagePath)) errors.push("storagePath is required");
      const row = {
        facility_id: params.facilityId,
        incident_id: params.incidentId,
        attachment_type: payload.attachmentType,
        storage_path: payload.storagePath,
        captured_at: payload.capturedAt ?? null,
        captured_by: auth.claims.sub,
        checksum_sha256: payload.checksum ?? null,
        metadata: payload.metadata ?? {}
      };
      return { row, errors };
    }
  });

  // --- Work order attachments (work_order_attachments) -----------------------
  registerEntity(router, {
    entitySegment: "work-orders",
    entityParam: "workOrderId",
    downloadPrefix: "work-order",
    permission: "work_orders.manage",
    readPermission: "work_orders.read",
    storageEntity: "work-orders",
    table: "work_order_attachments",
    columns: WORK_ORDER_ATTACHMENT_COLUMNS,
    buildInsertRow(params, payload, auth) {
      const errors = [];
      if (!isNonEmptyString(payload.storagePath)) errors.push("storagePath is required");
      if (!isNonEmptyString(payload.mimeType)) errors.push("mimeType is required");
      const row = {
        facility_id: params.facilityId,
        work_order_id: params.workOrderId,
        storage_path: payload.storagePath,
        mime_type: payload.mimeType,
        checksum: payload.checksum ?? null,
        metadata: payload.metadata ?? {},
        created_by: auth.claims.sub
      };
      return { row, errors };
    }
  });

  return router;
}
