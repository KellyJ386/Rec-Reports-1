// Pure, DOM-free helpers behind the role-based home dashboard (Wave 2 Slice
// 2D, P-3): which quick-action buttons and summary tiles a caller may see
// (driven entirely by the permission codes their current facility grants),
// plus the two bits of client-side data shaping the dashboard needs that no
// single endpoint already provides -- "certifications expiring within 30
// days" (from the enriched employee-certifications rows) and "today's
// shifts for me" (joining a period's shift_assignments back onto its
// schedule_shifts). No `document`, no fetch -- every input here is plain
// data the caller (app.js) has already fetched or derived.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRING_WINDOW_DAYS = 30;

// --- Quick actions -----------------------------------------------------------
// Mirrors the exact permission code each target panel's own create control
// gates on in app.js, so a quick action never offers something the panel
// itself would refuse to show:
//   - Submit report:   startNewReport's POST /facilities/:id/reports route
//     requires reports.create (src/lib/http/reports-routes.mjs's CREATE).
//   - Log incident:    incidentsPanel's "Report new incident" toggle is
//     gated on hasPerm("incidents.manage") (app.js render()).
//   - New work order:  workOrdersPanel's "New work order" toggle is gated
//     on hasPerm("work_orders.manage") (app.js render()).
export const QUICK_ACTIONS = Object.freeze([
  Object.freeze({
    key: "submit-report",
    label: "Submit report",
    permission: "reports.create",
    panelId: "panel-daily-reports"
  }),
  Object.freeze({
    key: "log-incident",
    label: "Log incident",
    permission: "incidents.manage",
    panelId: "panel-incidents"
  }),
  Object.freeze({
    key: "new-work-order",
    label: "New work order",
    permission: "work_orders.manage",
    panelId: "panel-work-orders"
  })
]);

function toPermissionSet(permissions) {
  if (permissions instanceof Set) return permissions;
  return new Set(Array.isArray(permissions) ? permissions : []);
}

// permissions: an array (or Set) of permission codes the caller holds in the
// active facility -- app.js's hasPerm() already resolves the platform-admin
// bypass before calling this, so this function itself never special-cases
// platformAdmin (see HOME_DASHBOARD_PERMISSION_CODES below for how the
// wiring code does that).
export function buildQuickActions(permissions) {
  const perms = toPermissionSet(permissions);
  return QUICK_ACTIONS.filter((action) => perms.has(action.permission)).map((action) => ({ ...action }));
}

// --- Tiles ---------------------------------------------------------------

// The full set of permission codes any quick action or tile in this module
// checks against. app.js's platform-admin bypass (hasPerm: "if
// (platformAdmin) return true") has no equivalent membership row to read
// permissions off of for a facility the admin doesn't belong to, so the
// wiring code passes this whole list in place of a real permission array
// when platformAdmin is true, matching what hasPerm would answer for each
// individual code.
export const HOME_DASHBOARD_PERMISSION_CODES = Object.freeze([
  "reports.create",
  "reports.read",
  "incidents.manage",
  "incidents.read",
  "work_orders.manage",
  "work_orders.read",
  "communications.read",
  "schedule.read"
]);

function isFiniteDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

// Sums a GET .../reports/compliance response's per-template totals (already
// the single day's totals when the caller requested ?from=today&to=today)
// into one { expected, submitted, missing, overdue } for the tile.
function summarizeCompliance(compliance) {
  const templates = Array.isArray(compliance?.templates) ? compliance.templates : [];
  return templates.reduce(
    (acc, template) => ({
      expected: acc.expected + (template?.expected ?? 0),
      submitted: acc.submitted + (template?.submitted ?? 0),
      missing: acc.missing + (template?.missing ?? 0),
      overdue: acc.overdue + (template?.overdue ?? 0)
    }),
    { expected: 0, submitted: 0, missing: 0, overdue: 0 }
  );
}

// Certifications whose expires_at falls within [now, now + windowDays],
// inclusive of both ends -- an already-expired certification (expiresAt <
// now) is a different, more urgent problem than "expiring soon" and is
// deliberately excluded here, as is a revoked one (its expiry date, if any,
// no longer means anything). Rows with no expires_at never expire and are
// excluded too. Accepts both the live snake_case row shape
// (employee-certifications, training-routes.mjs) and, defensively, a
// camelCase one.
export function computeExpiringCertifications(certifications = [], now = new Date(), windowDays = DEFAULT_EXPIRING_WINDOW_DAYS) {
  if (!isFiniteDate(now)) return [];
  const windowEnd = new Date(now.getTime() + windowDays * MS_PER_DAY);
  return (certifications || []).filter((cert) => {
    if (!cert || cert.status === "revoked") return false;
    const raw = cert.expires_at ?? cert.expiresAt;
    if (!raw) return false;
    const expiresAt = new Date(raw);
    if (!isFiniteDate(expiresAt)) return false;
    return expiresAt >= now && expiresAt <= windowEnd;
  });
}

// Joins one schedule period's shift_assignments back onto its schedule_shifts
// (assignments carry no shift_date of their own) and keeps only the caller's
// own live assignments (default status filter already applied server-side,
// GET .../shift-assignments?period_id=) whose shift falls on `today`.
// Returns [] (never throws) when myEmployeeId is unset -- a caller with no
// employee record in this facility has no shifts to show, not an error.
// today defaults to `now`'s UTC calendar date, matching every other
// UTC-wall-clock date convention in this codebase (reports-compliance.mjs,
// schedule-board.mjs).
export function computeTodayShiftsForMe({ shifts = [], assignments = [], myEmployeeId = null, today = null } = {}) {
  if (!myEmployeeId) return [];
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const shiftsById = new Map((shifts || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  return (assignments || [])
    .filter((assignment) => assignment && assignment.employee_id === myEmployeeId)
    .map((assignment) => shiftsById.get(assignment.shift_id))
    .filter((shift) => shift && shift.shift_date === todayStr)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
}

function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
}

const TILE_DEFS = [
  {
    key: "reports-due-today",
    title: "Reports due today",
    permission: "reports.read",
    panelId: "panel-daily-reports",
    build: ({ compliance }) => {
      if (compliance === null || compliance === undefined) {
        return { value: "Unavailable", hint: "Could not load report compliance." };
      }
      const summary = summarizeCompliance(compliance);
      const hint =
        summary.overdue > 0
          ? `${summary.overdue} ${pluralize(summary.overdue, "report overdue", "reports overdue")}`
          : summary.missing > 0
            ? `${summary.missing} not yet filed`
            : "All caught up";
      return { value: `${summary.submitted}/${summary.expected} filed`, hint };
    }
  },
  {
    key: "my-open-work-orders",
    title: "My open work orders",
    permission: "work_orders.read",
    panelId: "panel-work-orders",
    build: ({ workOrders }) => {
      if (workOrders === null || workOrders === undefined) {
        return { value: "Unavailable", hint: "Could not load work orders." };
      }
      return {
        value: String(workOrders.length),
        hint: pluralize(workOrders.length, "open work order assigned to you", "open work orders assigned to you")
      };
    }
  },
  {
    key: "open-incidents",
    title: "Open incidents",
    permission: "incidents.read",
    panelId: "panel-incidents",
    build: ({ incidents }) => {
      if (incidents === null || incidents === undefined) {
        return { value: "Unavailable", hint: "Could not load incidents." };
      }
      return {
        value: String(incidents.length),
        hint: pluralize(incidents.length, "submitted incident awaiting review", "submitted incidents awaiting review")
      };
    }
  },
  {
    key: "unacknowledged-messages",
    title: "Unacknowledged messages",
    permission: "communications.read",
    panelId: "panel-communications",
    build: ({ unackedMessages }) => {
      if (unackedMessages === null || unackedMessages === undefined) {
        return { value: "Unavailable", hint: "Could not load messages." };
      }
      return {
        value: String(unackedMessages.length),
        hint: pluralize(unackedMessages.length, "message needs your acknowledgement", "messages need your acknowledgement")
      };
    }
  },
  {
    key: "expiring-certifications",
    // GET .../employee-certifications with no ?employeeId= resolves the
    // caller's own wallet and requires only facility membership (not
    // training.read, training-routes.mjs) -- this is "my" data, so unlike
    // the other tiles it carries no permission gate; every viewer of the
    // dashboard is, by construction, a member of the active facility.
    title: "Expiring certifications",
    permission: null,
    panelId: "panel-certifications",
    build: ({ certifications, now }) => {
      if (certifications === null || certifications === undefined) {
        return { value: "Unavailable", hint: "Could not load certifications." };
      }
      const expiring = computeExpiringCertifications(certifications, now);
      return {
        value: String(expiring.length),
        hint: pluralize(expiring.length, "certification expiring within 30 days", "certifications expiring within 30 days")
      };
    }
  },
  {
    key: "today-shifts",
    title: "Today's shifts",
    permission: "schedule.read",
    panelId: "panel-schedule",
    build: ({ todayShifts }) => {
      if (todayShifts === null || todayShifts === undefined) {
        return { value: "Unavailable", hint: "Could not load today's shifts." };
      }
      return { value: String(todayShifts.length), hint: pluralize(todayShifts.length, "shift today", "shifts today") };
    }
  }
];

// input: { permissions, compliance, workOrders, incidents, unackedMessages,
//   certifications, todayShifts, now }. Every data field independently may
// be:
//   - null/undefined  -- that tile's fetch failed or was never attempted;
//     renders as "Unavailable" rather than a blank/missing tile.
//   - an array/object -- that fetch's (possibly empty) result.
// Only tiles whose permission (null means "always eligible", see
// expiring-certifications above) is held are returned, so a caller who lacks
// e.g. incidents.read never sees an "Open incidents" tile at all -- not even
// an "Unavailable" one, since that fetch is never attempted for them.
export function buildTiles({
  permissions,
  compliance = null,
  workOrders = null,
  incidents = null,
  unackedMessages = null,
  certifications = null,
  todayShifts = null,
  now = new Date()
} = {}) {
  const perms = toPermissionSet(permissions);
  const data = { compliance, workOrders, incidents, unackedMessages, certifications, todayShifts, now };
  return TILE_DEFS.filter((def) => def.permission === null || perms.has(def.permission)).map((def) => ({
    key: def.key,
    title: def.title,
    panelId: def.panelId,
    ...def.build(data)
  }));
}
