// Pure, DOM-free helpers behind the Assets sub-panel (WO-13): the filter
// query-string builder consumed by GET /facilities/:facilityId/assets
// (WO-12's ?status=/?category=/?q=/?limit=/?offset= surface), create/edit
// form validation and payload shaping for POST/PATCH .../assets, and the
// asset-picker option list shared by both the Assets panel and the work
// order create form. Vocabularies are copied from src/lib/work-orders.mjs's
// ASSET_STATUSES/ASSET_CRITICALITY_LEVELS check-constraint constants
// (browser code cannot import src/lib -- it never ships to dist/), same
// convention as work-order-filters.mjs's own copy of the work order enums.

export const ASSET_STATUSES = ["active", "inactive", "retired"];
export const ASSET_CRITICALITY_LEVELS = ["low", "medium", "high", "critical"];

const DEFAULT_PAGE_SIZE = 20;

// Builds the URLSearchParams GET /facilities/:facilityId/assets accepts from
// the panel's { status, category, q, page, pageSize } filter state. All
// three filters are independent/composable, matching the route's own
// ?status=&category=&q= surface; an empty/whitespace-only q is omitted
// entirely rather than sent as an empty string (the server would 400 a
// too-short q, so this keeps an untouched search box from ever producing a
// request that fails validation).
export function buildAssetQuery({ status = "", category = "", q = "", page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  if (status && ASSET_STATUSES.includes(status)) params.set("status", status);
  if (category && category.trim()) params.set("category", category.trim());
  if (q && q.trim()) params.set("q", q.trim());

  const size = Math.max(1, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE);
  const safePage = Math.max(1, Math.trunc(page) || 1);
  params.set("limit", String(size));
  params.set("offset", String((safePage - 1) * size));
  return params;
}

// Shared shape check for both create (name required) and edit (name still
// required if the field is present at all -- the edit form always carries
// it pre-filled, unlike the work order PATCH route's every-field-optional
// body). Criticality is optional; when set it must be one of the four
// levels, mirroring the route's own validateAssetFields.
export function validateAssetCreate(fields = {}) {
  const errors = {};
  if (!fields.name || !fields.name.trim()) errors.name = "Name is required.";
  if (fields.criticality && !ASSET_CRITICALITY_LEVELS.includes(fields.criticality)) {
    errors.criticality = "Select a valid criticality.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Shapes the create/edit form's field state into the JSON body
// POST/PATCH .../assets expects. Optional fields are only included when
// set, letting the server's own `?? null`/`?? {}` defaults apply uniformly
// to an untouched field (create) or leaving them out of a PATCH body
// entirely so they are never overwritten (edit) -- both routes already
// treat "field absent" and "field explicitly null" differently only for
// PATCH, and this only ever emits a key when the form actually set one.
export function buildAssetPayload(fields = {}) {
  const payload = { name: (fields.name || "").trim() };
  if (fields.assetTag) payload.asset_tag = fields.assetTag.trim();
  if (fields.locationText) payload.location_text = fields.locationText.trim();
  if (fields.departmentId) payload.department_id = fields.departmentId;
  if (fields.category) payload.category = fields.category.trim();
  if (fields.criticality) payload.criticality = fields.criticality;
  if (fields.installDate) payload.install_date = fields.installDate;
  if (fields.warrantyExpiresAt) payload.warranty_expires_at = fields.warrantyExpiresAt;
  return payload;
}

// Maps a list of asset rows (GET .../assets shape) into { value, label }
// option pairs for a <select>, shared by the Assets panel's own list-as-you-
// type affordance and the work order create form's asset picker (WO-13).
// A tagged asset shows its tag ahead of its name (matching how the Assets
// list/detail views identify a row); an untagged one just shows its name.
export function assetPickerOptions(assets = []) {
  return assets.map((asset) => ({
    value: asset.id,
    label: asset.asset_tag ? `${asset.asset_tag} — ${asset.name}` : asset.name
  }));
}

// Looks up a single asset's display name from an already-loaded list, for
// the work order detail view (WO-13: "WO detail shows the asset name").
// Returns null when the asset isn't in the list (not loaded, or the work
// order's asset_id is unset) so the caller can omit the row entirely rather
// than render a misleading blank.
export function findAssetName(assets = [], assetId) {
  if (!assetId) return null;
  const found = assets.find((asset) => asset.id === assetId);
  return found ? found.name : null;
}
