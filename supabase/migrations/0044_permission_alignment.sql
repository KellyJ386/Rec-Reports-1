-- ===========================================================================
-- 0044_permission_alignment.sql
-- Slice 1C, S-5 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md). Wires five of the
-- eight BFF-only permission codes (the eval's "no has_permission() occurrence"
-- list) into actual RLS predicates so the database enforces what the HTTP
-- layer already promises. incidents.export.pdf, reports.workflow.manage, and
-- reports.distribution.manage stay BFF-only by design (see the code catalog
-- comments in src/lib/permissions.mjs and scripts/typecheck.mjs's
-- bffOnlyPermissionCodes allow-list) -- incidents.export.pdf has no table
-- write beyond an audit event already covered by (incidents.manage or
-- incidents.review)'s incident_audit_events INSERT policy (0043), and the two
-- reports.* codes are reserved for DR-18/DR-21 with no route yet to gate.
--
-- Every helper call below is schema-qualified internal.<name>(...) per
-- 0042's header comment (mandatory for every migration >= 0043).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) reports.publish: split report_template_versions' UPDATE policy
-- (0028:129-135, latest definition) so is_published may only ever be flipped
-- to true under reports.publish; every other field edit on a still-draft
-- version keeps needing only reports.template.manage, exactly like before.
-- report-templates-routes.mjs's publish route already requires BOTH codes at
-- the HTTP layer (:277-ish, TEMPLATE_MANAGE and TEMPLATE_PUBLISH) -- this
-- closes the matching DB-layer gap so a reports.template.manage-only actor
-- could never publish a version by writing straight to PostgREST either.
-- fn_assert_same_facility(facility_id, 'report_templates', template_id)
-- carried over verbatim.
-- ---------------------------------------------------------------------------
drop policy if exists "template managers can update report template versions" on report_template_versions;
create policy "template managers can update report template versions" on report_template_versions
  for update
  using (internal.has_permission(auth.uid(), facility_id, 'reports.template.manage'))
  with check (
    internal.has_permission(auth.uid(), facility_id, 'reports.template.manage')
    and internal.fn_assert_same_facility(facility_id, 'report_templates', template_id)
    and (
      is_published = false
      or internal.has_permission(auth.uid(), facility_id, 'reports.publish')
    )
  );

-- ---------------------------------------------------------------------------
-- (b) incidents.tasks.create: ADD a permissive INSERT-only policy to
-- incident_followup_actions for incidents.tasks.create, alongside (not
-- replacing) the existing "incident managers can manage followups" `for all`
-- policy (0038:468-475, untouched). POST /incidents/:id/followups
-- (incidents-routes.mjs:764) already gates on tasks.create at the HTTP
-- layer; this closes the matching DB-layer gap without disturbing the
-- manage-gated policy's SELECT/UPDATE/DELETE coverage (a straight `for
-- insert`-only replacement of the `for all` policy would have silently
-- dropped the RETURNING-clause SELECT check for any incidents.manage holder
-- who does not separately hold incidents.read -- see 0043 (d)'s note on the
-- identical pitfall for incident_reports).
-- ---------------------------------------------------------------------------
drop policy if exists "incident task creators can insert followups" on incident_followup_actions;
create policy "incident task creators can insert followups" on incident_followup_actions
  for insert
  with check (
    internal.has_permission(auth.uid(), facility_id, 'incidents.tasks.create')
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

-- ---------------------------------------------------------------------------
-- (c) incidents.escalate: ADD a permissive INSERT-only policy to
-- incident_escalations for incidents.escalate, alongside (not replacing) the
-- existing "incident managers can manage escalations" `for all` policy
-- (0038:459-466, untouched), for the same reason as (b) above. Matches the
-- widened POST /incidents/:id/escalate route below.
-- ---------------------------------------------------------------------------
drop policy if exists "incident escalators can insert escalations" on incident_escalations;
create policy "incident escalators can insert escalations" on incident_escalations
  for insert
  with check (
    internal.has_permission(auth.uid(), facility_id, 'incidents.escalate')
    and internal.fn_assert_same_facility(facility_id, 'incident_reports', incident_id)
  );

-- ---------------------------------------------------------------------------
-- (d) incidents.legal_hold.manage: the column (incident_reports.legal_hold,
-- 0004) already exists; 0043's fn_incident_report_transition_guard already
-- enforces that it may only change under this code (written there, not here,
-- since it is the same slice's transition-guard function -- see 0043's
-- header). Nothing further needed at the DB layer; the route wiring is
-- below.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (e) incidents.audit.view: widen incident_audit_events' SELECT policy
-- (0010:123-125, re-asserted unchanged since) from incidents.manage alone to
-- incidents.audit.view OR incidents.manage OR incidents.review.
-- ---------------------------------------------------------------------------
drop policy if exists "incident managers can read audit" on incident_audit_events;
create policy "incident managers can read audit" on incident_audit_events
  for select using (
    internal.has_permission(auth.uid(), facility_id, 'incidents.audit.view')
    or internal.has_permission(auth.uid(), facility_id, 'incidents.manage')
    or internal.has_permission(auth.uid(), facility_id, 'incidents.review')
  );
