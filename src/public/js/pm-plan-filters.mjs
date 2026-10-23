// Pure, DOM-free helpers behind the "Preventive maintenance" sub-panel
// (WO-20): create/edit form validation + payload shaping for
// POST/PATCH .../pm-plans, season-month text-field parsing/formatting, and
// occurrence-strip label derivation for the "upcoming occurrences (next 8
// weeks)" strip built from GET .../pm-plans/:id/occurrences' merged
// stored+preview response. Vocabularies mirror
// src/lib/http/pm-plans-routes.mjs's own validation (browser code cannot
// import src/lib -- it never ships to dist/), not re-exported.

export const PM_CADENCE_TYPES = ["interval", "seasonal"];
export const PM_PRIORITIES = ["low", "medium", "high", "urgent"];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

// "3, 6, 9" / "3,6,9" -> [3, 6, 9]. Silently drops blanks and out-of-range
// entries -- validatePmPlanCreate is what surfaces a validation error for a
// truly malformed input; this just shapes whatever text is on screen into an
// array for the payload builder.
export function parseSeasonMonths(text = "") {
  return String(text)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
}

// [3, 6, 9] -> "3, 6, 9" -- populates the edit form's text field from a
// stored plan's season_months array.
export function formatSeasonMonths(months) {
  return Array.isArray(months) ? months.join(", ") : "";
}

export function monthAbbrev(monthNumber) {
  return MONTH_NAMES[(monthNumber - 1 + 12) % 12] ?? String(monthNumber);
}

// Validates the plan create/edit form's field state.
// fields: { title, cadenceType, intervalDays, seasonMonthsText, anchorDate,
//           leadTimeDays, priority, assetId, defaultAssigneeEmployeeId }
export function validatePmPlanCreate(fields = {}) {
  const errors = {};
  if (!fields.title || !fields.title.trim()) errors.title = "Title is required.";
  if (!fields.cadenceType || !PM_CADENCE_TYPES.includes(fields.cadenceType)) {
    errors.cadenceType = "Select a cadence.";
  } else if (fields.cadenceType === "interval") {
    const days = Number(fields.intervalDays);
    if (!Number.isInteger(days) || days < 1) errors.intervalDays = "Enter an interval of at least 1 day.";
  } else if (fields.cadenceType === "seasonal") {
    const months = parseSeasonMonths(fields.seasonMonthsText);
    if (months.length === 0) errors.seasonMonthsText = "Enter one or more months (1-12), comma-separated.";
  }
  if (!fields.anchorDate) errors.anchorDate = "Anchor date is required.";
  if (fields.leadTimeDays !== undefined && fields.leadTimeDays !== "") {
    const lead = Number(fields.leadTimeDays);
    if (!Number.isInteger(lead) || lead < 0) errors.leadTimeDays = "Lead time must be 0 or more days.";
  }
  if (fields.priority && !PM_PRIORITIES.includes(fields.priority)) errors.priority = "Select a valid priority.";
  return { valid: Object.keys(errors).length === 0, errors };
}

// Shapes the form's field state into the JSON body
// POST/PATCH .../pm-plans expects. Optional refs (asset, assignee,
// description, lead time, priority) are only included when set, letting the
// server's own defaults apply to an untouched field.
export function buildPmPlanPayload(fields = {}) {
  const payload = {
    title: (fields.title || "").trim(),
    cadence_type: fields.cadenceType,
    anchor_date: fields.anchorDate
  };
  if (fields.description) payload.description = fields.description.trim();
  if (fields.cadenceType === "interval") {
    payload.interval_days = Number(fields.intervalDays);
  } else if (fields.cadenceType === "seasonal") {
    payload.season_months = parseSeasonMonths(fields.seasonMonthsText);
  }
  if (fields.leadTimeDays !== undefined && fields.leadTimeDays !== "") {
    payload.lead_time_days = Number(fields.leadTimeDays);
  }
  if (fields.priority) payload.priority = fields.priority;
  if (fields.assetId) payload.asset_id = fields.assetId;
  if (fields.defaultAssigneeEmployeeId) payload.default_assignee_employee_id = fields.defaultAssigneeEmployeeId;
  return payload;
}

// Derives the upcoming-occurrences strip's per-item label from one entry of
// GET .../pm-plans/:id/occurrences' merged stored+preview response
// ({ scheduledFor, preview, workOrderId? }). Pure string shaping only -- the
// panel's own render() turns this into DOM via el(), never innerHTML.
export function occurrenceStatusLabel(occurrence) {
  if (!occurrence) return "";
  if (occurrence.preview) return "Upcoming";
  return occurrence.workOrderId ? "Work order created" : "Scheduled";
}

// Formats an occurrence's 'YYYY-MM-DD' scheduledFor as "Mon D" for the
// strip, without going through Date's locale-dependent, timezone-sensitive
// formatting (the date is a plain calendar date, not an instant).
export function formatOccurrenceDate(scheduledFor) {
  if (typeof scheduledFor !== "string") return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scheduledFor);
  if (!match) return scheduledFor;
  const [, , month, day] = match;
  return `${monthAbbrev(Number(month))} ${Number(day)}`;
}

// Filters+sorts a GET .../pm-plans/:id/occurrences response down to the
// next `limit` occurrences on/after `todayStr` ('YYYY-MM-DD') -- the
// "upcoming-occurrences strip (next 8 weeks)" the panel renders; the route
// already defaults its own window to 8 weeks, this just bounds the strip's
// item count and drops anything the caller-supplied window happened to
// include before today.
export function upcomingOccurrences(occurrences = [], todayStr, limit = 16) {
  return [...occurrences]
    .filter((o) => o.scheduledFor >= todayStr)
    .sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : 0))
    .slice(0, limit);
}
