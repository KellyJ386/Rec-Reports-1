-- =============================================================================
-- 20260616220000_integration.sql
-- Phase 5.1 — cross-module wiring support.
-- Asset inspection history is auto-populated when a member submits a PM/Inspection form
-- response (MODULE_SPEC.md §3.6 / §6). The submit runs as the (member) responder, so the
-- insert policy must allow any facility member — not only supervisor+. Append-only (§6).
-- =============================================================================

drop policy if exists asset_inspection_write on public.asset_inspection_history;

create policy asset_inspection_insert on public.asset_inspection_history
  for insert with check (public.is_facility_member(facility_id));

-- supervisor+ may still correct/remove history rows
create policy asset_inspection_modify on public.asset_inspection_history
  for update using (public.has_facility_role(facility_id, 'supervisor'))
  with check (public.has_facility_role(facility_id, 'supervisor'));
