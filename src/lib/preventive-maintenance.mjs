// WO-18: PM cadence domain lib. Pure, no I/O -- every date in and out is a
// plain 'YYYY-MM-DD' string, and every date computation is done in whole UTC
// calendar days (via Date.UTC, never `new Date(y, m, d)`'s local-timezone
// constructor), which is what makes this DST-safe: a UTC day has no DST
// transitions, so "anchor + N days" never gains or loses an hour the way
// local-time arithmetic can near a spring-forward/fall-back boundary.
//
// `plan` shape (camelCase, mirroring work-orders.mjs's createWorkOrderFromIncident
// convention -- callers map DB rows in/out at the I/O boundary, not here):
//   {
//     id, facilityId, assetId,
//     title, description,
//     cadenceType: 'interval' | 'seasonal',
//     intervalDays,          // required for 'interval'
//     anchorDate,            // 'YYYY-MM-DD', required for both cadence types
//     seasonMonths,          // integer[] 1-12, required for 'seasonal'
//     leadTimeDays = 0,
//     priority, defaultAssigneeEmployeeId,
//     active,                // inactive plans yield nothing from every fn below
//     createdAt              // ISO datetime/date; callers (pm-generation.mjs)
//                             // are responsible for never asking this module
//                             // for an occurrence window that starts before
//                             // it -- see that file's own header.
//   }
//
// An `occurrence` (as returned by occurrencesInWindow / built by
// workOrderFromPlan's caller) is `{ scheduledFor, generationDate }`, both
// 'YYYY-MM-DD' strings.

import { configValue } from "./settings-registry.mjs";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' (or any value new Date() accepts) -> whole UTC days since the
// epoch. Truncates a datetime input down to its UTC calendar date first, so
// passing an ISO timestamp (e.g. a row's created_at) behaves the same as
// passing just its date portion.
function toEpochDay(dateLike) {
  if (dateLike instanceof Date) {
    return Math.floor(Date.UTC(dateLike.getUTCFullYear(), dateLike.getUTCMonth(), dateLike.getUTCDate()) / MS_PER_DAY);
  }
  const text = String(dateLike);
  const match = DATE_PATTERN.exec(text.slice(0, 10));
  if (!match) throw new Error(`invalid date: ${dateLike}`);
  const [, y, m, d] = match;
  return Math.floor(Date.UTC(Number(y), Number(m) - 1, Number(d)) / MS_PER_DAY);
}

// Whole UTC days since the epoch -> 'YYYY-MM-DD'.
function fromEpochDay(epochDay) {
  const date = new Date(epochDay * MS_PER_DAY);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  return fromEpochDay(toEpochDay(dateStr) + days);
}

function daysInMonth(year, monthIndex0) {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

// The seasonal occurrence date for a given calendar year + 1-based month:
// the anchor's day-of-month, clamped to that month's actual last day (e.g.
// an anchor of the 31st lands on Feb 28th/29th).
function seasonalDateFor(year, month1, anchorDay) {
  const monthIndex0 = month1 - 1;
  const day = Math.min(anchorDay, daysInMonth(year, monthIndex0));
  return fromEpochDay(Math.floor(Date.UTC(year, monthIndex0, day) / MS_PER_DAY));
}

function isActive(plan) {
  return plan?.active !== false;
}

function withGenerationDate(plan, scheduledFor) {
  return { scheduledFor, generationDate: addDays(scheduledFor, -(plan.leadTimeDays ?? 0)) };
}

// All interval occurrence dates ('YYYY-MM-DD') in [fromStr, toStr]
// (inclusive both ends). Occurrences never precede the plan's anchor -- the
// anchor IS occurrence zero.
function intervalOccurrenceDatesInWindow(plan, fromStr, toStr) {
  const interval = plan.intervalDays;
  const anchorDay = toEpochDay(plan.anchorDate);
  const fromDay = toEpochDay(fromStr);
  const toDay = toEpochDay(toStr);
  if (toDay < anchorDay || toDay < fromDay) return [];

  const effectiveFromDay = Math.max(fromDay, anchorDay);
  const stepsFromAnchor = Math.ceil((effectiveFromDay - anchorDay) / interval);
  const firstN = Math.max(0, stepsFromAnchor);

  const dates = [];
  for (let n = firstN; ; n += 1) {
    const day = anchorDay + n * interval;
    if (day > toDay) break;
    if (day >= fromDay) dates.push(fromEpochDay(day));
  }
  return dates;
}

// All seasonal occurrence dates ('YYYY-MM-DD') in [fromStr, toStr]
// (inclusive), never before the plan's anchor date, one per (year, listed
// month) pair whose clamped date falls in range.
function seasonalOccurrenceDatesInWindow(plan, fromStr, toStr) {
  const anchorDay = toEpochDay(plan.anchorDate);
  const anchorDate = new Date(anchorDay * MS_PER_DAY);
  const anchorDayOfMonth = anchorDate.getUTCDate();
  const fromDay = Math.max(toEpochDay(fromStr), anchorDay);
  const toDay = toEpochDay(toStr);
  if (toDay < fromDay) return [];

  const fromYear = new Date(fromDay * MS_PER_DAY).getUTCFullYear();
  const toYear = new Date(toDay * MS_PER_DAY).getUTCFullYear();

  const dates = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    for (const month of plan.seasonMonths ?? []) {
      const dateStr = seasonalDateFor(year, month, anchorDayOfMonth);
      const day = toEpochDay(dateStr);
      if (day >= fromDay && day <= toDay) dates.push(dateStr);
    }
  }
  dates.sort();
  return dates;
}

function occurrenceDatesInWindow(plan, fromStr, toStr) {
  if (plan.cadenceType === "seasonal") return seasonalOccurrenceDatesInWindow(plan, fromStr, toStr);
  return intervalOccurrenceDatesInWindow(plan, fromStr, toStr);
}

// The next occurrence date strictly AFTER `after` (a 'YYYY-MM-DD' string or
// anything new Date() accepts), or null for an inactive plan. Looks a bit
// over a year ahead of `after` (enough to cross any seasonal cycle) rather
// than searching an unbounded window.
export function nextOccurrence(plan, after) {
  if (!isActive(plan)) return null;
  const afterStr = typeof after === "string" ? after.slice(0, 10) : fromEpochDay(toEpochDay(after));
  const searchTo = addDays(afterStr, 366 * 2);
  const dates = occurrenceDatesInWindow(plan, afterStr, searchTo);
  const strictlyAfter = dates.find((d) => toEpochDay(d) > toEpochDay(afterStr));
  return strictlyAfter ?? null;
}

// Every occurrence in [from, to] (inclusive both ends) as
// { scheduledFor, generationDate } objects, sorted ascending. Empty for an
// inactive plan.
export function occurrencesInWindow(plan, from, to) {
  if (!isActive(plan)) return [];
  const fromStr = typeof from === "string" ? from.slice(0, 10) : fromEpochDay(toEpochDay(from));
  const toStr = typeof to === "string" ? to.slice(0, 10) : fromEpochDay(toEpochDay(to));
  return occurrenceDatesInWindow(plan, fromStr, toStr).map((scheduledFor) => withGenerationDate(plan, scheduledFor));
}

// The work-order row (camelCase, mirroring createWorkOrderFromIncident) a
// given occurrence mints: source_type='pm', due_at = occurrence.scheduledFor
// (lead_time_days shifts WHEN the job generates it, never the due date
// itself -- that shift already happened, in occurrencesInWindow's
// generationDate). `config` optional -- falls back to workOrders.defaultPriority
// only when the plan itself carries no priority.
export function workOrderFromPlan(plan, occurrence, config = {}) {
  const priority = plan.priority || configValue(config, "workOrders.defaultPriority");
  return {
    facilityId: plan.facilityId,
    assetId: plan.assetId ?? null,
    sourceType: "pm",
    sourcePmPlanId: plan.id,
    title: plan.title,
    description: plan.description || plan.title,
    priority,
    status: "open",
    assignedToEmployeeId: plan.defaultAssigneeEmployeeId ?? null,
    dueAt: `${occurrence.scheduledFor}T00:00:00.000Z`
  };
}
