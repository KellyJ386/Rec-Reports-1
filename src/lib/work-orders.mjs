import { configValue } from "./settings-registry.mjs";

// Single source of truth for the DB check-constraint enums (0005_work_orders.sql).
export const WORK_ORDER_STATUSES = ["open", "in_progress", "on_hold", "resolved", "closed", "cancelled"];
export const WORK_ORDER_PRIORITIES = ["low", "medium", "high", "urgent"];
export const OPEN_STATUSES = ["open", "in_progress", "on_hold"];
// Manual-create-only enum (0005_work_orders.sql's source_type check
// constraint); the incident/report routes stamp their own source_type
// server-side and never accept it from a request body.
export const WORK_ORDER_SOURCE_TYPES = ["manual", "report", "incident"];
// Statuses that stamp completed_at when entered.
const COMPLETING_STATUSES = new Set(["resolved", "closed", "cancelled"]);
// WO-15: the narrower subset that also stamps resolved_at -- 'cancelled' is
// a completion (stops the clock), but never a resolution.
const RESOLVING_STATUSES = new Set(["resolved", "closed"]);

const priorityRank = { low: 1, medium: 2, high: 3, urgent: 4 };
const openStatuses = new Set(OPEN_STATUSES);
const urgentPriorities = new Set(["high", "urgent"]);

// The status lifecycle graph. `resolved` can be reopened back to
// `in_progress` (clearing completed_at); `closed` and `cancelled` are
// terminal. Same-status "transitions" are not legal moves.
const STATUS_TRANSITIONS = {
  open: new Set(["in_progress", "on_hold", "cancelled"]),
  in_progress: new Set(["on_hold", "resolved", "cancelled"]),
  on_hold: new Set(["in_progress", "cancelled"]),
  resolved: new Set(["in_progress", "closed"]),
  closed: new Set(),
  cancelled: new Set()
};

export function isWorkOrderOpen(workOrder) {
  return openStatuses.has(workOrder.status);
}

// Whether a work order may move from status `from` to status `to`. Unknown
// statuses and same-status "transitions" are always illegal.
export function canTransition(from, to) {
  if (!from || !to) return false;
  if (from === to) return false;
  return Boolean(STATUS_TRANSITIONS[from]?.has(to));
}

// Computes the field patch for moving a work order to `next` status. Callers
// should gate on canTransition(workOrder.status, next) first (this function
// does not itself validate legality — it only derives completed_at). Entering
// a completing status (resolved/closed/cancelled) stamps completed_at; moving
// back out of one (reopening) clears it.
export function applyStatusChange(workOrder, next, now = new Date()) {
  return {
    status: next,
    completed_at: COMPLETING_STATUSES.has(next) ? now.toISOString() : null
  };
}

export function isWorkOrderOverdue(workOrder, now = new Date()) {
  return isWorkOrderOpen(workOrder) && Boolean(workOrder.dueAt) && new Date(workOrder.dueAt) < now;
}

// WO-15: whether `next` is a status that stamps resolved_at when entered
// (narrower than the completing-status set applyStatusChange already keys
// off of -- see RESOLVING_STATUSES above). Exported so the route layer can
// derive resolved_at without duplicating the status list itself.
export function isResolvingStatus(status) {
  return RESOLVING_STATUSES.has(status);
}

// WO-15: minimum at-risk window in hours, used regardless of how short a
// work order's own SLA window is (see slaState below).
const MIN_AT_RISK_HOURS = 4;
// The fraction of a work order's own [createdAt, slaDueAt] window that
// counts as "at risk" once entered, when that fraction exceeds
// MIN_AT_RISK_HOURS.
const AT_RISK_WINDOW_FRACTION = 0.2;

// slaState(workOrder, config, now) -> { state, dueAt, remainingHours }.
//
// `workOrder` reads camelCase fields (slaDueAt, slaBreachedAt, createdAt),
// matching every other domain helper in this module -- the route layer maps
// the DB's snake_case columns before calling this. `config` is accepted for
// forward compatibility (a future per-facility at-risk-threshold override)
// but is not read today; every threshold below is a fixed module constant.
//
// Rules (WO-15's acceptance: "at_risk within the last 20% of the window or
// <= 4h, whichever is larger"):
//   - No sla_due_at at all -> 'on_track' (nothing to measure against; a work
//     order predating WO-15 with no due_at either backfills to null, see
//     0060's migration header).
//   - Already stamped breached (sla_breached_at set), OR now is at/past
//     sla_due_at (remainingHours <= 0) -> 'breached'. The scan (WO-16) is
//     what durably STAMPS sla_breached_at, but this function reports the
//     breached STATE as soon as the deadline has passed even if the scan
//     hasn't run yet -- "is this overdue" should never lag a periodic job by
//     definition, only the notification side effect does.
//   - Otherwise: the window is [createdAt, slaDueAt] (falling back to the
//     MIN_AT_RISK_HOURS floor alone when createdAt is unknown or the window
//     is non-positive, e.g. malformed data). at_risk when the remaining time
//     is at or under max(20% of that window, 4h); otherwise on_track.
// Boundary is inclusive at both ends (remainingHours === threshold counts as
// at_risk; remainingHours === 0 counts as breached), so the three states
// partition the timeline with no gap.
export function slaState(workOrder, config = {}, now = new Date()) {
  const dueAtRaw = workOrder?.slaDueAt;
  if (!dueAtRaw) return { state: "on_track", dueAt: null, remainingHours: null };

  const dueAt = new Date(dueAtRaw);
  const remainingHours = (dueAt.getTime() - now.getTime()) / (60 * 60 * 1000);

  if (workOrder?.slaBreachedAt || remainingHours <= 0) {
    return { state: "breached", dueAt: dueAt.toISOString(), remainingHours };
  }

  let atRiskThresholdHours = MIN_AT_RISK_HOURS;
  const createdAtRaw = workOrder?.createdAt;
  if (createdAtRaw) {
    const createdAt = new Date(createdAtRaw);
    const windowHours = (dueAt.getTime() - createdAt.getTime()) / (60 * 60 * 1000);
    if (windowHours > 0) {
      atRiskThresholdHours = Math.max(windowHours * AT_RISK_WINDOW_FRACTION, MIN_AT_RISK_HOURS);
    }
  }

  const state = remainingHours <= atRiskThresholdHours ? "at_risk" : "on_track";
  return { state, dueAt: dueAt.toISOString(), remainingHours };
}

export function sortWorkOrdersForDashboard(workOrders, now = new Date()) {
  return [...workOrders].sort((first, second) => {
    const overdueDelta = Number(isWorkOrderOverdue(second, now)) - Number(isWorkOrderOverdue(first, now));
    if (overdueDelta !== 0) return overdueDelta;
    const priorityDelta = priorityRank[second.priority] - priorityRank[first.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return new Date(first.createdAt) - new Date(second.createdAt);
  });
}

// SLA hours for a work order's priority, driven by workOrders.slaHoursUrgent
// (high/urgent) and workOrders.slaHoursRoutine (low/medium). `config` optional.
export function slaHoursForPriority(priority, config = {}) {
  return urgentPriorities.has(priority)
    ? configValue(config, "workOrders.slaHoursUrgent")
    : configValue(config, "workOrders.slaHoursRoutine");
}

// The due date implied by a work order's priority SLA, measured from `createdAt`
// (or now). Lets facilities drive overdue detection from configured SLAs.
export function workOrderDueAt(workOrder, config = {}, now = new Date()) {
  const anchor = workOrder.createdAt ? new Date(workOrder.createdAt) : now;
  const hours = slaHoursForPriority(workOrder.priority, config);
  return new Date(anchor.getTime() + hours * 60 * 60 * 1000);
}

// `config` optional. The fallback priority (when severity is neither high nor
// critical) honors workOrders.defaultPriority; the shipped default is 'medium'.
export function createWorkOrderFromIncident(incident, defaults = {}, config = {}) {
  const fallbackPriority = configValue(config, "workOrders.defaultPriority");
  return {
    sourceType: "incident",
    sourceId: incident.id,
    facilityId: incident.facilityId,
    title: defaults.title ?? `Follow up: ${incident.incidentNo}`,
    description: defaults.description ?? incident.summary,
    priority: incident.severity === "critical" ? "urgent" : incident.severity === "high" ? "high" : fallbackPriority,
    status: "open"
  };
}
