import test from "node:test";
import assert from "node:assert/strict";
import {
  kindForMime,
  validateContentUpload,
  shapeContentItem,
  ALLOWED_CONTENT_MIME_TYPES,
  TRAINING_STORAGE_MODULE
} from "../src/lib/training-content.mjs";
import { assertPathInFacility, buildAttachmentPath, StorageValidationError } from "../src/lib/storage.mjs";

const FACILITY = "5b1f4f0e-0000-4000-8000-000000000001";
const MODULE_ID = "5b1f4f0e-0000-4000-8000-0000000000aa";

test("kindForMime maps the allow-listed types and rejects everything else", () => {
  assert.equal(kindForMime("video/mp4"), "video");
  assert.equal(kindForMime("VIDEO/WEBM; codecs=vp9"), "video");
  assert.equal(kindForMime("application/pdf"), "pdf");
  assert.equal(kindForMime("image/png"), null);
  assert.equal(kindForMime(undefined), null);
  assert.deepEqual([...ALLOWED_CONTENT_MIME_TYPES].sort(), ["application/pdf", "video/mp4", "video/webm"]);
});

test("validateContentUpload enforces the per-module-type content contract", () => {
  assert.deepEqual(validateContentUpload({ moduleType: "video", contentType: "video/mp4" }), { valid: true, errors: [], kind: "video" });
  assert.equal(validateContentUpload({ moduleType: "pdf", contentType: "application/pdf" }).kind, "pdf");
  // a video file on a pdf module (and vice versa)
  assert.equal(validateContentUpload({ moduleType: "pdf", contentType: "video/mp4" }).valid, false);
  assert.equal(validateContentUpload({ moduleType: "video", contentType: "application/pdf" }).valid, false);
  // modules that cannot carry files
  for (const moduleType of ["quiz", "checklist", "sop_link"]) {
    assert.equal(validateContentUpload({ moduleType, contentType: "video/mp4" }).valid, false, moduleType);
  }
  assert.equal(validateContentUpload({ moduleType: "video", contentType: "image/png" }).valid, false);
  assert.equal(validateContentUpload({ moduleType: "video", contentType: "video/mp4", title: " " }).valid, false);
  assert.equal(validateContentUpload({ moduleType: "video", contentType: "video/mp4", title: "x".repeat(201) }).valid, false);
});

test("shapeContentItem never exposes the storage path", () => {
  const shaped = shapeContentItem({
    id: "i1",
    module_id: "m1",
    kind: "video",
    title: "Intro",
    storage_path: "facilities/f/training/m/uuid-intro.mp4",
    mime_type: "video/mp4",
    size_bytes: 10,
    checksum_sha256: "abc",
    order_no: 0,
    created_at: "2026-01-01"
  });
  assert.equal(JSON.stringify(shaped).includes("storage_path"), false);
  assert.equal(JSON.stringify(shaped).includes("facilities/"), false);
  assert.equal(shaped.kind, "video");
});

test("the training storage module round-trips through buildAttachmentPath / assertPathInFacility with the module id bound", () => {
  const path = buildAttachmentPath(FACILITY, TRAINING_STORAGE_MODULE, MODULE_ID, "Intro Video.mp4");
  assert.match(path, new RegExp(`^facilities/${FACILITY}/training/${MODULE_ID}/[0-9a-f-]{36}-Intro-Video\\.mp4$`));
  assert.equal(assertPathInFacility(path, FACILITY, TRAINING_STORAGE_MODULE, MODULE_ID), path);
  // wrong module id, wrong facility, wrong storage module, traversal
  assert.throws(() => assertPathInFacility(path, FACILITY, TRAINING_STORAGE_MODULE, "5b1f4f0e-0000-4000-8000-0000000000bb"), StorageValidationError);
  assert.throws(() => assertPathInFacility(path, "5b1f4f0e-0000-4000-8000-000000000002", TRAINING_STORAGE_MODULE, MODULE_ID), StorageValidationError);
  assert.throws(() => assertPathInFacility(path, FACILITY, "reports", MODULE_ID), StorageValidationError);
  assert.throws(
    () => assertPathInFacility(`facilities/${FACILITY}/training/${MODULE_ID}/../../x/y.mp4`, FACILITY, TRAINING_STORAGE_MODULE, MODULE_ID),
    StorageValidationError
  );
});
