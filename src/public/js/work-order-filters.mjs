// Pure, DOM-free helpers behind the Work Orders panel (WO-10): the filter-
// chip + priority + pagination query-string builder consumed by
// GET /facilities/:facilityId/work-orders (WO-05's ?status=/?assignee=/
// ?overdue=/?priority=/?limit=/?offset= surface), plus create-form
// validation/payload shaping for POST .../work-orders. Vocabularies are
// copied from src/lib/work-orders.mjs's check-constraint constants (browser
// code cannot import src/lib -- it never ships to dist/), not re-exported.

export const WORK_ORDER_STATUSES = ["open", "in_progress", "on_hold", "resolved", "closed", "cancelled"];
export const WORK_ORDER_PRIORITIES = ["low", "medium", "high", "urgent"];

// The panel's filter chips (WO-10's "open / mine / overdue / priority").
// 'priority' is not a chip value itself -- it's driven by a separate select
// -- but is listed here for documentation of the full filter surface.
export const WORK_ORDER_CHIPS = ["all", "open", "mine", "overdue"];

const DEFAULT_PAGE_SIZE = 20;

// Builds the URLSearchParams GET /facilities/:facilityId/work-orders accepts
// from the panel's { chip, priority, myEmployeeId, page, pageSize } state.
// chip and priority are independent, composable axes (e.g. "open" work
// orders AND "high" priority); 'mine' only takes effect when myEmployeeId is
// supplied (no assignee filter is ever emitted without it, rather than
// silently filtering to nothing). limit/offset are always emitted (WO-05
// bounds/defaults them server-side regardless, so sending them explicitly
// keeps the UI's own page state and the server's response in agreement).
export function buildWorkOrderQuery({ chip = "all", priority = "", myEmployeeId = null, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  if (chip === "open") params.set("status", "open");
  if (chip === "overdue") params.set("overdue", "true");
  if (chip === "mine" && myEmployeeId) params.set("assignee", myEmployeeId);
  if (priority && WORK_ORDER_PRIORITIES.includes(priority)) params.set("priority", priority);

  const size = Math.max(1, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE);
  const safePage = Math.max(1, Math.trunc(page) || 1);
  params.set("limit", String(size));
  params.set("offset", String((safePage - 1) * size));
  return params;
}

export function validateWorkOrderCreate(fields = {}) {
  const errors = {};
  if (!fields.title || !fields.title.trim()) errors.title = "Title is required.";
  if (!fields.description || !fields.description.trim()) errors.description = "Description is required.";
  if (!fields.priority || !WORK_ORDER_PRIORITIES.includes(fields.priority)) errors.priority = "Select a priority.";
  return { valid: Object.keys(errors).length === 0, errors };
}

// Shapes the create form's field state into the JSON body
// POST /facilities/:facilityId/work-orders expects. Optional refs (asset,
// assignee, due date) are only included when set, letting the server's own
// `?? null` defaults apply uniformly to an untouched field.
export function buildWorkOrderCreatePayload(fields = {}) {
  const payload = {
    title: (fields.title || "").trim(),
    description: (fields.description || "").trim(),
    priority: fields.priority
  };
  if (fields.assetId) payload.asset_id = fields.assetId;
  if (fields.assignedToEmployeeId) payload.assigned_to_employee_id = fields.assignedToEmployeeId;
  if (fields.dueAt) payload.due_at = fields.dueAt;
  return payload;
}
