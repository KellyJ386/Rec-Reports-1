// Pure helpers for the Training Studio admin surface (courses, course_modules;
// 0007). No I/O here: the route layer loads/writes rows and passes payloads in,
// so every function is a deterministic transform that node:test can exercise
// directly. Mirrors the shape of ../admin/cert-policy.mjs.

const COURSE_STATUSES = ["draft", "published", "archived"];
const MODULE_TYPES = ["video", "pdf", "sop_link", "quiz", "checklist"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Validate a candidate courses insert payload. Returns { valid, errors } in
// the same shape as the http/validate.mjs and settings-registry helpers.
export function validateCourseInput(input = {}) {
  const errors = [];
  if (typeof input.code !== "string" || input.code.trim().length === 0) {
    errors.push("code is required");
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    errors.push("title is required");
  }
  if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
    errors.push("description must be a string");
  }
  if (input.status !== undefined && !COURSE_STATUSES.includes(input.status)) {
    errors.push(`status must be one of: ${COURSE_STATUSES.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}

// Validate a candidate courses PATCH payload. Every field is optional, but
// any field that is present must be well-shaped.
export function validateCourseUpdateInput(input = {}) {
  const errors = [];
  if (input.code !== undefined && (typeof input.code !== "string" || input.code.trim().length === 0)) {
    errors.push("code must be a non-empty string");
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.trim().length === 0)) {
    errors.push("title must be a non-empty string");
  }
  if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
    errors.push("description must be a string");
  }
  if (input.status !== undefined && !COURSE_STATUSES.includes(input.status)) {
    errors.push(`status must be one of: ${COURSE_STATUSES.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}

// Validate a candidate course_modules insert payload. `content` stays
// free-form (URL/text only) for M1 -- it just has to be an object.
export function validateCourseModuleInput(input = {}) {
  const errors = [];
  if (!MODULE_TYPES.includes(input.moduleType)) {
    errors.push(`moduleType must be one of: ${MODULE_TYPES.join(", ")}`);
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    errors.push("title is required");
  }
  if (!Number.isInteger(input.orderNo) || input.orderNo < 0) {
    errors.push("orderNo must be a non-negative integer");
  }
  if (input.content !== undefined && !isPlainObject(input.content)) {
    errors.push("content must be an object");
  }
  if (input.required !== undefined && typeof input.required !== "boolean") {
    errors.push("required must be a boolean");
  }
  return { valid: errors.length === 0, errors };
}

// Validate a candidate course_modules PATCH payload. Every field is optional,
// but any field that is present must be well-shaped.
export function validateCourseModuleUpdateInput(input = {}) {
  const errors = [];
  if (input.moduleType !== undefined && !MODULE_TYPES.includes(input.moduleType)) {
    errors.push(`moduleType must be one of: ${MODULE_TYPES.join(", ")}`);
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.trim().length === 0)) {
    errors.push("title must be a non-empty string");
  }
  if (input.orderNo !== undefined && (!Number.isInteger(input.orderNo) || input.orderNo < 0)) {
    errors.push("orderNo must be a non-negative integer");
  }
  if (input.content !== undefined && !isPlainObject(input.content)) {
    errors.push("content must be an object");
  }
  if (input.required !== undefined && typeof input.required !== "boolean") {
    errors.push("required must be a boolean");
  }
  return { valid: errors.length === 0, errors };
}
