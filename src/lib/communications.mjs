export function resolveMessageAudience(message, context) {
  const recipients = new Set();
  for (const audience of message.audiences ?? []) {
    if (audience.type === "employee") recipients.add(audience.id);
    if (audience.type === "department") {
      for (const employee of context.employees.filter((item) => item.departmentId === audience.id)) recipients.add(employee.id);
    }
    if (audience.type === "shift") {
      for (const assignment of context.shiftAssignments.filter((item) => item.shiftId === audience.id)) recipients.add(assignment.employeeId);
    }
  }
  return [...recipients].sort();
}

export function acknowledgementState(message, receipts, now = new Date()) {
  if (!message.isRequiredAck) return "not_required";
  const acknowledgedCount = receipts.filter((receipt) => receipt.acknowledgedAt).length;
  if (acknowledgedCount >= message.requiredRecipientCount) return "complete";
  if (message.ackDueAt && new Date(message.ackDueAt) < now) return "overdue";
  return "pending";
}

export function shouldBypassQuietHours(message) {
  return message.priority === "emergency" || message.priority === "urgent";
}
