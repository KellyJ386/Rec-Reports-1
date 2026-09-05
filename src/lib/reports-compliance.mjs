// DR-12 (plans/DAILY_REPORTS_PLAN.md): pure daily-report compliance
// computation. For each published report template and each calendar date in
// a [from, to] range, derive {expected, submitted, missing, overdue}. No I/O
// here -- the route layer (reports-routes.mjs) loads templates/submissions
// and the effective `reports.dailyReportDueHour` config, then calls
// computeCompliance with plain data.
//
// Timezone basis (explicit, load-bearing -- this is the whole point of the
// "timezone handling explicit" acceptance bar): report_date is a plain DATE
// with no attached timezone (report_submissions.report_date, 0002), and
// reports.dailyReportDueHour (settings-registry.mjs) is a bare 0-23 hour
// with no timezone qualifier either. This module treats both as UTC
// wall-clock values: a date's deadline is the instant
// "${date}T${dueHour zero-padded}:00:00.000Z", and `now` (a JS Date,
// defaults to `new Date()`, i.e. the current UTC instant) is compared
// directly against that deadline.
//
// It deliberately does NOT resolve facilities.timezone (0001, e.g.
// 'America/New_York') into facility-local wall-clock time. Doing so would
// require this pure module to accept and thread a timezone parameter through
// Intl/date arithmetic, which DR-12 does not ask for -- a future task can add
// it without changing this module's other semantics. Until then, a facility
// whose timezone differs from UTC sees its due-hour boundary shift by that
// offset; that is a written-down assumption, not a hidden bug.
import { configValue } from "./settings-registry.mjs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isPublished(template) {
  return template?.status === "published";
}

// A submission counts as "filed" once it has left draft -- submitted,
// locked, or revised all satisfy compliance; only 'draft' (still being
// filled in) does not.
function isFiled(status) {
  return status === "submitted" || status === "locked" || status === "revised";
}

// Every calendar date in [from, to], inclusive, as YYYY-MM-DD strings.
// Invalid input (bad format, non-existent range, from > to) yields [].
export function dateRange(from, to) {
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) return [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const dates = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += MS_PER_DAY) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

// True once `now` (UTC) reaches or passes the due deadline for `date` given
// `dueHour` (0-23, UTC wall-clock -- see module header).
function isPastDue(date, dueHour, now) {
  const deadline = new Date(`${date}T${String(dueHour).padStart(2, "0")}:00:00.000Z`);
  return now.getTime() >= deadline.getTime();
}

// A template is only "expected" to have a report from the date it existed
// onward -- template.created_at is the earliest per-template timestamp
// available without also loading report_template_versions (DR-12 does not
// load those), so a date before a template's created_at date counts as not
// expected rather than missing. A template with no/invalid created_at is
// treated as always having existed (expected on every date in range).
function firstEligibleDate(template) {
  const raw = template?.created_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

// computeCompliance({ templates, submissions, from, to, config, now }) ->
// { from, to, dueHour, templates: [{ templateId, code, name, departmentId,
//   days: [{ date, expected, submitted, missing, overdue }], expected,
//   submitted, missing, overdue }] }
//
// `templates` rows need at least { id, code, name, department_id, status,
// created_at }; non-published templates are excluded entirely. `submissions`
// rows need { template_id, report_date, status }.
export function computeCompliance({
  templates = [],
  submissions = [],
  from,
  to,
  config = {},
  now = new Date()
} = {}) {
  const dueHour = configValue(config, "reports.dailyReportDueHour");
  const dates = dateRange(from, to);
  const published = (templates ?? []).filter(isPublished);

  const filedByTemplateDate = new Set();
  for (const submission of submissions ?? []) {
    if (!submission || !isFiled(submission.status)) continue;
    filedByTemplateDate.add(`${submission.template_id}::${submission.report_date}`);
  }

  const templateSummaries = published.map((template) => {
    const eligibleFrom = firstEligibleDate(template);
    const days = dates.map((date) => {
      const eligible = eligibleFrom === null || date >= eligibleFrom;
      const expected = eligible ? 1 : 0;
      const submitted = eligible && filedByTemplateDate.has(`${template.id}::${date}`) ? 1 : 0;
      const missing = expected === 1 && submitted === 0 ? 1 : 0;
      const overdue = missing === 1 && isPastDue(date, dueHour, now) ? 1 : 0;
      return { date, expected, submitted, missing, overdue };
    });
    const totals = days.reduce(
      (acc, day) => ({
        expected: acc.expected + day.expected,
        submitted: acc.submitted + day.submitted,
        missing: acc.missing + day.missing,
        overdue: acc.overdue + day.overdue
      }),
      { expected: 0, submitted: 0, missing: 0, overdue: 0 }
    );
    return {
      templateId: template.id,
      code: template.code ?? null,
      name: template.name ?? null,
      departmentId: template.department_id ?? null,
      days,
      ...totals
    };
  });

  return { from, to, dueHour, templates: templateSummaries };
}
