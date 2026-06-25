-- Verification intent: active memberships must only expose rows whose facility_id is in current_facility_ids().
select has_table_privilege('authenticated', 'facilities', 'select') as authenticated_can_select_facilities;
select relrowsecurity from pg_class where relname in ('facilities', 'memberships', 'roles');
