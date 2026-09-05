-- ===========================================================================
-- 0027_permission_expansion.sql
-- Permission catalog expansion (DR-05 + IN-01): nine fine-grained governance
-- codes covering daily-report publishing/workflow/distribution governance and
-- incident review/escalation/legal-hold/export/audit-view. Idempotent
-- throughout (on conflict do nothing), safe to re-run against any facility.
--
-- Unlike every earlier permission code, these were never shipped only through
-- supabase/seed.sql: a live database already bootstrapped from the pre-0027
-- seed needs this migration to (a) add the new rows to the `permissions`
-- catalog and (b) grant them to each facility's already-provisioned system
-- roles. (b) is expressed by joining on `roles.name` + `is_system_role`
-- rather than the demo facility's hardcoded UUIDs, so it grants correctly
-- across every tenant/facility, not only the seeded demo one.
--
-- New codes:
--   reports.publish              -- publish a report template/version
--                                    (reports.template.manage alone can author
--                                    a draft but not publish it)
--   reports.workflow.manage      -- manage a template's on_submit workflow
--                                    automation rules
--   reports.distribution.manage  -- manage a template's distribution
--                                    lists/delivery routing
--   incidents.review             -- review/approve an incident report
--   incidents.escalate           -- trigger/advance an incident escalation
--   incidents.tasks.create       -- create incident follow-up tasks
--   incidents.legal_hold.manage  -- place/release a legal hold on an incident
--   incidents.export.pdf         -- export an incident (legal packet) PDF
--   incidents.audit.view         -- view the immutable incident audit trail
--
-- Role-grant matrix (mirrors supabase/seed.sql's role_permissions comment):
--   Tenant Owner, Compliance Admin (facility/ops admin tier -- both already
--     hold admin.manage or full reporting/incident governance) -- ALL NINE.
--   Ops Admin (supervisor tier -- day-to-day operations, no admin.manage) --
--     incidents.review, incidents.escalate, incidents.tasks.create,
--     reports.publish only. Deliberately withheld: incidents.legal_hold.manage,
--     incidents.export.pdf, incidents.audit.view, reports.workflow.manage,
--     reports.distribution.manage -- these stay admin-tier-only.
--   Read-Only Auditor (frontline/read-only tier) -- NONE of the nine.
-- ===========================================================================

insert into permissions (code, description) values
  ('reports.publish', 'Publish report templates and versions'),
  ('reports.workflow.manage', 'Manage report submission workflow automation rules'),
  ('reports.distribution.manage', 'Manage report distribution lists and delivery routing'),
  ('incidents.review', 'Review and approve incident reports'),
  ('incidents.escalate', 'Escalate incidents to higher review levels'),
  ('incidents.tasks.create', 'Create incident follow-up tasks'),
  ('incidents.legal_hold.manage', 'Place and release legal holds on incidents'),
  ('incidents.export.pdf', 'Export incident legal packet PDFs'),
  ('incidents.audit.view', 'View the immutable incident audit trail')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Facility/ops admin tier -- Tenant Owner and Compliance Admin -- all nine.
-- ---------------------------------------------------------------------------
insert into role_permissions (role_id, permission_code)
select r.id, codes.code
from roles r
cross join (values
  ('reports.publish'),
  ('reports.workflow.manage'),
  ('reports.distribution.manage'),
  ('incidents.review'),
  ('incidents.escalate'),
  ('incidents.tasks.create'),
  ('incidents.legal_hold.manage'),
  ('incidents.export.pdf'),
  ('incidents.audit.view')
) as codes(code)
where r.is_system_role and r.name in ('Tenant Owner', 'Compliance Admin')
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- Supervisor tier -- Ops Admin -- day-to-day review/escalate/tasks/publish
-- only; legal-hold, export, audit-view, and workflow/distribution management
-- stay admin-tier-only.
-- ---------------------------------------------------------------------------
insert into role_permissions (role_id, permission_code)
select r.id, codes.code
from roles r
cross join (values
  ('incidents.review'),
  ('incidents.escalate'),
  ('incidents.tasks.create'),
  ('reports.publish')
) as codes(code)
where r.is_system_role and r.name = 'Ops Admin'
on conflict (role_id, permission_code) do nothing;

-- Read-Only Auditor (frontline/read-only tier): intentionally granted none of
-- the nine new codes -- it neither administers nor supervises.
