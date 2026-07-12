import { configValue } from "./settings-registry.mjs";

const priorityRank = { low: 1, medium: 2, high: 3, urgent: 4 };
const openStatuses = new Set(["open", "in_progress", "on_hold"]);
const urgentPriorities = new Set(["high", "urgent"]);

export function isWorkOrderOpen(workOrder) {
  return openStatuses.has(workOrder.status);
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
