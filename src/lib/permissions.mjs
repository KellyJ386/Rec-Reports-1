export const permissions = Object.freeze([
  "reports.read",
  "reports.create",
  "reports.submit",
  "reports.export",
  "schedule.read",
  "schedule.manage",
  // schedule.manage alone can build/edit a period's shifts and assignments
  // but cannot push them live -- publishing is its own governance surface
  // (SC-07), gated separately so a facility can grant day-to-day scheduling
  // without also granting the ability to publish.
  "schedule.publish",
  "training.read",
  "training.manage",
  "incidents.read",
  "incidents.manage",
  // Fine-grained incident governance codes (IN-01). Not implied by
  // incidents.manage: a supervisor may review/escalate/create tasks without
  // holding full incidents.manage, and legal_hold/export.pdf/audit.view are
  // restricted to facility/ops admin roles even where incidents.manage is held.
  // RLS wiring (0043/0044, Slice 1C S-4/S-5): incidents.escalate gates
  // incident_escalations INSERT (OR incidents.manage), incidents.tasks.create
  // gates incident_followup_actions INSERT (OR incidents.manage),
  // incidents.legal_hold.manage gates incident_reports.legal_hold changes
  // (fn_incident_report_transition_guard, 0043) and PATCH
  // /incidents/:id/legal-hold, incidents.audit.view gates incident_audit_events
  // SELECT (OR incidents.manage/incidents.review). incidents.export.pdf is
  // BFF-only by design (scripts/typecheck.mjs's bffOnlyPermissionCodes): the
  // GET /incidents/:id/export.pdf route gates on it, but the only DB write it
  // triggers is an incident_audit_events insert already covered by that
  // table's (incidents.manage or incidents.review) INSERT policy, so there is
  // no separate RLS predicate for this code to appear in.
  "incidents.review",
  "incidents.escalate",
  "incidents.tasks.create",
  "incidents.legal_hold.manage",
  "incidents.export.pdf",
  "incidents.audit.view",
  "work_orders.read",
  "work_orders.manage",
  "admin.manage",
  "reports.template.manage",
  // Reports governance codes (DR-05). reports.template.manage alone can author
  // a template but cannot publish it, manage its workflow automation, or
  // manage its distribution lists -- each is its own governance surface.
  // reports.publish is wired into RLS (0044, Slice 1C S-5): it gates the
  // report_template_versions UPDATE policy's is_published=true transition
  // (OR reports.template.manage for every other field). reports.workflow.manage
  // is BFF-only by design, reserved for DR-18/DR-20
  // (scripts/typecheck.mjs's bffOnlyPermissionCodes) -- no route or RLS
  // predicate exists yet. reports.distribution.manage (DR-21, 0054) is no
  // longer BFF-only: it gates report_distribution_lists' write RLS policy
  // directly and the GET/POST/PATCH/DELETE
  // .../report-distribution-lists routes (src/lib/http/
  // report-distribution-routes.mjs).
  "reports.publish",
  "reports.workflow.manage",
  "reports.distribution.manage",
  "communications.read",
  "communications.publish"
]);

// True when the membership is not narrowed to a department (0023): a null or
// absent departmentId is the facility-wide, pre-0023 shape.
function isFacilityWide(membership) {
  return membership.departmentId === null || membership.departmentId === undefined;
}

export function canAccessFacility(memberships, facilityId) {
  return memberships.some(
    (membership) => membership.facilityId === facilityId && membership.status === "active"
  );
}

// Mirrors the 3-arg SQL has_permission (0023): facility-scope checks pass only
// via FACILITY-WIDE memberships. A department-scoped membership narrows its
// permissions to that department and contributes nothing at facility scope.
export function hasPermission(memberships, facilityId, permission) {
  return memberships.some(
    (membership) =>
      membership.facilityId === facilityId &&
      membership.status === "active" &&
      isFacilityWide(membership) &&
      membership.permissions.includes(permission)
  );
}

// Mirrors the 4-arg SQL has_permission overload (0023): a department-scoped
// check passes via a facility-wide membership or a membership scoped to
// exactly that department.
export function hasDepartmentPermission(memberships, facilityId, departmentId, permission) {
  return memberships.some(
    (membership) =>
      membership.facilityId === facilityId &&
      membership.status === "active" &&
      (isFacilityWide(membership) || membership.departmentId === departmentId) &&
      membership.permissions.includes(permission)
  );
}
