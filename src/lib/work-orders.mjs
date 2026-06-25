const priorityRank = { low: 1, medium: 2, high: 3, urgent: 4 };
const openStatuses = new Set(["open", "in_progress", "on_hold"]);

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

export function createWorkOrderFromIncident(incident, defaults = {}) {
  return {
    sourceType: "incident",
    sourceId: incident.id,
    facilityId: incident.facilityId,
    title: defaults.title ?? `Follow up: ${incident.incidentNo}`,
    description: defaults.description ?? incident.summary,
    priority: incident.severity === "critical" ? "urgent" : incident.severity === "high" ? "high" : "medium",
    status: "open"
  };
}
