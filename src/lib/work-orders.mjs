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

// IN-17: the direct-insert half of the incident-followup -> work-order link
// (POST .../followups/:followupId/work-order). Reuses createWorkOrderFromIncident
// for the sourceType/sourceId/facilityId/priority/status shape and adds
// sourceFollowupId (work_orders.source_followup_id, 0058) plus a title/
// description derived from the FOLLOW-UP specifically (rather than the bare
// incident) -- never from a client-supplied body, matching the RPC path
// (internal.create_work_order_from_incident in 0058_incident_cross_module.sql)
// this mirrors: both derive title/description/priority server-side from the
// same two rows so a caller with work_orders.manage (this JS path) and one
// without it (the RPC path) end up with an identical row shape regardless of
// which permission got them there. `config` optional, same contract as
// createWorkOrderFromIncident.
export function createWorkOrderFromIncidentFollowup(incident, followup, config = {}) {
  const base = createWorkOrderFromIncident(
    incident,
    {
      title: `Follow up: ${incident.incidentNo} (${followup.actionType})`,
      description: followup.description || incident.summary
    },
    config
  );
  return { ...base, sourceFollowupId: followup.id };
}
