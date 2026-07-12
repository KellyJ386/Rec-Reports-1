-- 0016_notifications.sql
-- Notifications routing -- design 3.5 (idempotent throughout).
-- A facility-scoped routing layer over the existing notification_jobs /
-- notification_deliveries fan-out tables (0006):
--   * notification_events   -- global catalog of event codes (read-all, like
--                              the modules table); severity + default channels
--   * distribution_lists    -- named, facility-scoped recipient groups
--   * distribution_list_members -- employee/role members of a list
--   * notification_routes   -- per-facility event -> route rules with priority
--
-- notification_route_overrides (a separate org-vs-facility override layer) is
-- deliberately NOT created here: in this cut the facility route IS the override
-- layer (there is no org-level routing yet), so a second overrides table would
-- be dead weight. Org-level routing + a real override precedence can be added
-- later without reshaping these tables.
--
-- Reads: notification_events is open to any authenticated user (a shared
-- catalog); lists/members/routes are readable by facility members. Writes on
-- lists/members/routes are gated on the EXISTING 'communications.publish' code
-- from the 16-code catalog, and audited via fn_audit_admin_change (0010).
--
-- Idempotency conventions (mirroring 0009-0015): drop policy/trigger if exists
-- before every create; create table/index if not exists.

-- ---------------------------------------------------------------------------
-- (a) notification_events -- the global event catalog. Seeded in seed.sql.
-- default_channels_jsonb is an array of channel codes matching
-- notification_deliveries.channel ('in_app','email','sms','push').
-- ---------------------------------------------------------------------------
create table if not exists notification_events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  module_code text not null,
  default_channels_jsonb jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- (b) distribution_lists -- named, facility-scoped recipient groups.
-- ---------------------------------------------------------------------------
create table if not exists distribution_lists (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, name)
);

-- ---------------------------------------------------------------------------
-- (c) distribution_list_members -- an employee or role member of a list.
-- Carries facility_id so RLS/audit work like every other config table; the
-- WITH CHECK asserts facility consistency with the parent list.
-- ---------------------------------------------------------------------------
create table if not exists distribution_list_members (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  distribution_list_id uuid not null references distribution_lists(id) on delete cascade,
  member_type text not null check (member_type in ('employee', 'role')),
  member_ref_id uuid not null,
  created_at timestamptz not null default now(),
  unique (distribution_list_id, member_type, member_ref_id)
);

-- ---------------------------------------------------------------------------
-- (d) notification_routes -- per-facility event -> route rules. Highest active
-- priority wins (resolved by src/lib/admin/notifications.mjs resolveRoute).
-- event_code references the global catalog so a route can only target a known
-- event.
-- ---------------------------------------------------------------------------
create table if not exists notification_routes (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  event_code text not null references notification_events(code),
  priority integer not null default 0,
  route_jsonb jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, event_code, priority)
);

create index if not exists distribution_lists_facility_idx on distribution_lists(facility_id) where active;
create index if not exists distribution_list_members_list_idx on distribution_list_members(distribution_list_id);
create index if not exists notification_routes_facility_event_idx on notification_routes(facility_id, event_code, priority desc) where active;

alter table notification_events enable row level security;
alter table distribution_lists enable row level security;
alter table distribution_list_members enable row level security;
alter table notification_routes enable row level security;

-- notification_events: a shared catalog, readable by any authenticated user
-- (mirrors "authenticated users can read module catalog" on modules, 0008).
drop policy if exists "authenticated users can read notification events" on notification_events;
create policy "authenticated users can read notification events" on notification_events
  for select to authenticated using (true);

drop policy if exists "members can read distribution lists" on distribution_lists;
create policy "members can read distribution lists" on distribution_lists
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "publishers can manage distribution lists" on distribution_lists;
create policy "publishers can manage distribution lists" on distribution_lists
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish'))
  with check (has_permission(auth.uid(), facility_id, 'communications.publish'));

drop policy if exists "members can read distribution list members" on distribution_list_members;
create policy "members can read distribution list members" on distribution_list_members
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "publishers can manage distribution list members" on distribution_list_members;
create policy "publishers can manage distribution list members" on distribution_list_members
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish'))
  with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'distribution_lists', distribution_list_id)
  );

drop policy if exists "members can read notification routes" on notification_routes;
create policy "members can read notification routes" on notification_routes
  for select using (facility_id in (select current_facility_ids()));

drop policy if exists "publishers can manage notification routes" on notification_routes;
create policy "publishers can manage notification routes" on notification_routes
  for all using (has_permission(auth.uid(), facility_id, 'communications.publish'))
  with check (has_permission(auth.uid(), facility_id, 'communications.publish'));

drop trigger if exists distribution_lists_audit_change on distribution_lists;
create trigger distribution_lists_audit_change
  after insert or update or delete on distribution_lists
  for each row execute function fn_audit_admin_change();

drop trigger if exists distribution_list_members_audit_change on distribution_list_members;
create trigger distribution_list_members_audit_change
  after insert or update or delete on distribution_list_members
  for each row execute function fn_audit_admin_change();

drop trigger if exists notification_routes_audit_change on notification_routes;
create trigger notification_routes_audit_change
  after insert or update or delete on notification_routes
  for each row execute function fn_audit_admin_change();
