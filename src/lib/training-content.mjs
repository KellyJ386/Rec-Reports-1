// TR-08: pure helpers for video/PDF module content (training_content_items;
// 0065). Files live in the shared attachments bucket under
//   facilities/{facilityId}/training/{moduleId}/{uuid}-{filename}
// built by storage.mjs's buildAttachmentPath(facilityId, "training",
// moduleId, filename) -- the SAME primitive every other module uses, so the
// signed-URL route can assert the path with assertPathInFacility(path,
// facilityId, TRAINING_STORAGE_MODULE, moduleId) before ever calling storage.

export const TRAINING_STORAGE_MODULE = "training";

export const CONTENT_KINDS = Object.freeze(["video", "pdf"]);

// Per-type content contract: which module types accept uploads, and which
// MIME types each accepts. A module's own module_type decides the kind of
// every item attached to it (0065's fn_training_content_path_facility
// enforces the same equality in the database).
const MIME_TYPES_BY_KIND = Object.freeze({
  video: Object.freeze(["video/mp4", "video/webm"]),
  pdf: Object.freeze(["application/pdf"])
});

export const ALLOWED_CONTENT_MIME_TYPES = Object.freeze([...MIME_TYPES_BY_KIND.video, ...MIME_TYPES_BY_KIND.pdf]);

export function kindForMime(contentType) {
  const normalized = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
  for (const kind of CONTENT_KINDS) {
    if (MIME_TYPES_BY_KIND[kind].includes(normalized)) return kind;
  }
  return null;
}

// Validates an upload request against its target module BEFORE any I/O.
//   moduleType   the course_modules.module_type of the target module
//   contentType  the request's Content-Type header
//   title        optional display title (defaults to the file name upstream)
export function validateContentUpload({ moduleType, contentType, title } = {}) {
  const errors = [];
  if (!CONTENT_KINDS.includes(moduleType)) {
    errors.push(`content can only be attached to a ${CONTENT_KINDS.join(" or ")} module (this module is ${moduleType})`);
  }
  const kind = kindForMime(contentType);
  if (!kind) {
    errors.push(`content type must be one of: ${ALLOWED_CONTENT_MIME_TYPES.join(", ")}`);
  } else if (CONTENT_KINDS.includes(moduleType) && kind !== moduleType) {
    errors.push(`a ${kind} file cannot be attached to a ${moduleType} module`);
  }
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0 || title.length > 200)) {
    errors.push("title must be a non-empty string of at most 200 characters");
  }
  return { valid: errors.length === 0, errors, kind };
}

// Shapes a training_content_items row for the API: never exposes the raw
// storage path (callers fetch a short-lived signed URL by item id instead).
export function shapeContentItem(row) {
  return {
    id: row.id,
    moduleId: row.module_id,
    kind: row.kind,
    title: row.title,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes ?? null,
    orderNo: row.order_no,
    createdAt: row.created_at
  };
}
