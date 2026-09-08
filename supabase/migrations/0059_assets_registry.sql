-- ===========================================================================
-- 0059_assets_registry.sql
-- WO-11: extends the `assets` table (0005) into a real equipment registry --
-- category, a criticality rating, an open-ended metadata bag, and the two
-- lifecycle dates a maintenance program needs (install date, warranty
-- expiry) -- ahead of WO-12's CRUD routes and WO-13's UI. Purely additive:
-- new nullable/defaulted columns plus a covering index. Idempotent
-- throughout (mirrors 0007/0029/0055): `add column if not exists`, inline
-- `check` on the new column itself (skipped along with the column add on a
-- re-run, so no separate DO-block/pg_constraint guard is needed the way a
-- constraint added to an EXISTING column would require -- see 0055's
-- pdf_content_hash precedent for that other case), `create index if not
-- exists`.
--
-- Facts checked against the repo at this migration's authoring time:
--   * `unique (facility_id, asset_tag)` already exists on `assets` since its
--     original creation (0005_work_orders.sql:12) -- WO-12's 409-on-conflict
--     acceptance criterion is already satisfied by the schema; nothing to
--     add here, and re-declaring it would 500 on every apply after the
--     first (Postgres has no `add constraint if not exists`). Verified
--     empirically: `\d assets` on a freshly-bootstrapped database already
--     shows `assets_facility_id_asset_tag_key`.
--   * `assets`' two RLS policies were NOT left verbatim as 0005 wrote them --
--     both were already rewritten in place by later migrations, and both
--     already satisfy the two conditions that would require touching them
--     again here (a missing `deleted_at is null` read filter, or a bare
--     un-rewritten `auth.uid()`). Verified empirically against a freshly
--     bootstrapped database (`\d assets` / `pg_policies`), not just by
--     reading the migration text, since three separate migrations touch
--     these two policies and only the live, composed result matters:
--       - "work order readers can read assets" (0005_work_orders.sql:73):
--         0009_rls_hardening.sql:183-185 dropped/recreated it to add
--         `and deleted_at is null` to its USING clause. 0049 (below) then
--         wrapped its `auth.uid()`.
--       - "work order managers can manage assets" (0005_work_orders.sql:74):
--         0038_rls_audit_hardening.sql:228-234 (PART 3, department_id
--         family) dropped/recreated it to add `and deleted_at is null` to
--         USING and `fn_assert_same_facility(facility_id, 'departments',
--         department_id)` to WITH CHECK. 0049 (below) then wrapped its
--         `auth.uid()`.
--       - 0049_policy_performance.sql's auth_rls_initplan fix is a DO block
--         that walks `pg_policies` for every policy (any table) whose
--         qual/with_check contains a bare `auth.uid()`, so it is not
--         table-name-grep-able (confirmed: 0049's file text contains no
--         literal `assets`) -- but it ran across the whole `public` schema
--         and so *did* catch both of these policies, which is why the live
--         `pg_policies` row for each now reads `( SELECT auth.uid() AS
--         uid)`, not a bare call.
--     Net effect: today's live policies already carry `deleted_at is null`
--     on read and the `(select auth.uid())` rewrite on both -- neither
--     condition for touching them is met, so they are left untouched here.
--   * Cross-facility protection for `work_orders.asset_id` already exists:
--     0013_audit_chain.sql:200-206 added `fn_assert_same_facility(facility_id,
--     'assets', asset_id)` to the WITH CHECK of "work order managers can
--     manage work orders" (not a BEFORE trigger the way 0035's child-table
--     guard is -- 0035's own header comment explains why work_orders itself
--     was left out of that trigger: it references assets/departments/
--     employees, not another work_orders row, so 0013's WITH CHECK approach
--     already covers exactly this FK). `supabase/tests/assets_registry.sql`
--     (below) proves this holds for the new registry columns' presence too.
-- ===========================================================================

alter table assets
  add column if not exists category text,
  add column if not exists criticality text check (criticality in ('low', 'medium', 'high', 'critical')),
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists install_date date,
  add column if not exists warranty_expires_at date;

-- Covering index for WO-12's list route (`GET /facilities/:facilityId/assets
-- ?category=`), mirroring assets_facility_department_idx's shape (partial on
-- deleted_at is null -- assets has no soft-delete route yet, but every other
-- read/index in this table already carries the same guard for when one
-- lands, and a partial index costs nothing extra to declare now).
create index if not exists assets_facility_category_idx on assets(facility_id, category) where deleted_at is null;

-- Seed: extend the one existing asset row (supabase/seed.sql) with a
-- category/criticality so WO-12's ?category= filter and WO-13's list/detail
-- UI have something non-null to render against a freshly-bootstrapped
-- database. supabase/seed.sql itself carries the matching update for the
-- row's INSERT statement; nothing to do here (a migration should not seed
-- data -- that stays seed.sql's job) beyond noting the pairing.

notify pgrst, 'reload schema';
