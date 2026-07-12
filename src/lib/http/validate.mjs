function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateModuleTogglePayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["payload must be an object"] };
  }
  if (typeof payload.enabled !== "boolean") {
    errors.push("enabled is required and must be a boolean");
  }
  if (payload.configPatch !== undefined && !isPlainObject(payload.configPatch)) {
    errors.push("configPatch must be a plain object");
  }
  return { valid: errors.length === 0, errors };
}
