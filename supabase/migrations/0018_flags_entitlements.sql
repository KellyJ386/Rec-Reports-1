-- 0018_flags_entitlements.sql
-- Feature flags & Entitlements/Billing -- design 3.2 + 3.9 (idempotent throughout).
-- The last Phase 7 table set. Two related domains:
--
-- Feature flags (3.2):
--   * feature_flags       -- global catalog of flag keys (read-all, like modules)
--   * feature_flag_rules  -- per-scope (organization|facility) overrides, with an
--                            optional percentage rollout and a time window
--
-- Entitlements / billing (3.9):
--   * subscription_plans  -- global catalog of plans (read-all); each names its
--                            entitlement keys in feature_entitlements_jsonb
--   * tenant_subscriptions-- one active plan per organization (UNIQUE org)
--   * usage_counters      -- per-metric usage rollups for soft-limit meters
--
-- Write authority:
--   * feature_flag_rules  -- org rows: is_organization_admin(scope_id);
--                            facility rows: admin.manage on scope_id. One
--                            OR-policy keeps the two paths readable.
--   * tenant_subscriptions-- NO client write policy on purpose: billing state is
--                            mutated by the payment webhook / service role, never
--                            the app. Org members may READ their subscription.
--   * usage_counters      -- service-role writes only (metering job); org admins
--                            may READ.
--   * feature_flags / subscription_plans -- global catalogs seeded in seed.sql;
--                            no client write policy (service role owns them).
--
-- Audit: feature_flag_rules + tenant_subscriptions carry fn_audit_admin_change.
-- Because those tables are org/scope-shaped (no plain facility_id column), the
-- audit function is extended below to derive scope from scope_type/scope_id and
-- from organization_id, so their audit rows land with the right tenant scope.
--
-- Idempotency conventions (mirroring 0009-0017): drop policy/trigger if exists
-- before every create; create table/index if not exists.

-- ---------------------------------------------------------------------------
-- (a) feature_flags -- the global flag catalog. rollout_type is 'boolean' (a
-- plain on/off) or 'percentage' (rules may carry a rollout_percentage).
-- default_state applies when no rule matches a caller's scope.
-- ---------------------------------------------------------------------------
create table if not exists feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text,
  rollout_type text not null default 'boolean' check (rollout_type in ('boolean', 'percentage')),
  default_state boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- (b) feature_flag_rules -- scope overrides. scope_id points at an organization
-- or a facility depending on scope_type. rollout_percentage (0-100) is only
-- meaningful for percentage flags; starts_at/ends_at bound an optional active
-- window (a NULL bound is open-ended).
-- ---------------------------------------------------------------------------
create table if not exists feature_flag_rules (
  id uuid primary key default gen_random_uuid(),
  feature_flag_id uuid not null references feature_flags(id) on delete cascade,
  scope_type text not null check (scope_type in ('organization', 'facility')),
  scope_id uuid not null,
  state boolean not null default true,
  rollout_percentage integer check (rollout_percentage is null or (rollout_percentage between 0 and 100)),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (feature_flag_id, scope_type, scope_id)
);

-- ---------------------------------------------------------------------------
-- (c) subscription_plans -- the global plan catalog. feature_entitlements_jsonb
-- is an object of entitlement-key -> true (e.g. {"cert_policies":true}).
-- ---------------------------------------------------------------------------
create table if not exists subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  base_price_cents integer not null default 0,
  billing_period text not null default 'monthly' check (billing_period in ('monthly', 'annual')),
  feature_entitlements_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- (d) tenant_subscriptions -- one row per organization (UNIQUE). usage_limits_jsonb
-- carries per-metric soft limits paired with usage_counters. Mutated by the
-- payment webhook / service role, not the app (no client write policy below).
-- ---------------------------------------------------------------------------
create table if not exists tenant_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  plan_id uuid not null references subscription_plans(id),
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'canceled')),
  starts_at timestamptz not null default now(),
  renews_at timestamptz,
  seat_limit integer,
  usage_limits_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- (e) usage_counters -- per-metric usage in a period. Written by the metering
-- job (service role); read by org admins for the usage meters.
-- ---------------------------------------------------------------------------
create table if not exists usage_counters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  metric_code text not null,
  period_start date not null,
  period_end date not null,
  value bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, metric_code, period_start)
);

create index if not exists feature_flag_rules_flag_idx on feature_flag_rules(feature_flag_id, scope_type, scope_id);
create index if not exists feature_flag_rules_scope_idx on feature_flag_rules(scope_type, scope_id);
create index if not exists usage_counters_org_metric_idx on usage_counters(organization_id, metric_code, period_start desc);

alter table feature_flags enable row level security;
alter table feature_flag_rules enable row level security;
alter table subscription_plans enable row level security;
alter table tenant_subscriptions enable row level security;
alter table usage_counters enable row level security;

-- feature_flags: a shared catalog, readable by any authenticated user
-- (mirrors "authenticated users can read module catalog" on modules, 0008).
drop policy if exists "authenticated users can read feature flags" on feature_flags;
create policy "authenticated users can read feature flags" on feature_flags
  for select to authenticated using (true);

-- feature_flag_rules: readable by anyone in the scoped tenant; writable by the
-- scope's admin (org admin for org rows, admin.manage holder for facility rows).
drop policy if exists "tenant members can read feature flag rules" on feature_flag_rules;
create policy "tenant members can read feature flag rules" on feature_flag_rules
  for select using (
    (scope_type = 'facility' and scope_id in (select current_facility_ids()))
    or (
      scope_type = 'organization'
      and scope_id in (select organization_id from facilities where id in (select current_facility_ids()))
    )
  );

drop policy if exists "scope admins can manage feature flag rules" on feature_flag_rules;
create policy "scope admins can manage feature flag rules" on feature_flag_rules
  for all using (
    (scope_type = 'organization' and is_organization_admin(auth.uid(), scope_id))
    or (scope_type = 'facility' and has_permission(auth.uid(), scope_id, 'admin.manage'))
  )
  with check (
    (scope_type = 'organization' and is_organization_admin(auth.uid(), scope_id))
    or (scope_type = 'facility' and has_permission(auth.uid(), scope_id, 'admin.manage'))
  );

-- subscription_plans: a shared catalog, readable by any authenticated user.
drop policy if exists "authenticated users can read subscription plans" on subscription_plans;
create policy "authenticated users can read subscription plans" on subscription_plans
  for select to authenticated using (true);

-- tenant_subscriptions: org members may read their org's subscription. No write
-- policy: billing state is mutated by the payment webhook / service role only.
drop policy if exists "org members can read their subscription" on tenant_subscriptions;
create policy "org members can read their subscription" on tenant_subscriptions
  for select using (
    organization_id in (select organization_id from facilities where id in (select current_facility_ids()))
  );

-- usage_counters: org admins may read usage; service role writes (no write policy).
drop policy if exists "org admins can read usage counters" on usage_counters;
create policy "org admins can read usage counters" on usage_counters
  for select using (is_organization_admin(auth.uid(), organization_id));

-- ---------------------------------------------------------------------------
-- Extend fn_audit_admin_change (0010) to scope the org/scope-shaped tables
-- introduced here. The only change from 0010 is the added branch for
-- feature_flag_rules (scope_type/scope_id) and the organization_id fallback for
-- tables (tenant_subscriptions, usage_counters) that carry organization_id but
-- no facility_id. Every other table keeps the exact 0010 behavior.
-- ---------------------------------------------------------------------------
create or replace function fn_audit_admin_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec jsonb;
  before_json jsonb;
  after_json jsonb;
  v_entity_id uuid;
  v_facility_id uuid;
  v_organization_id uuid;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    before_json := null;
    after_json := to_jsonb(new);
    rec := to_jsonb(new);
  elsif tg_op = 'DELETE' then
    before_json := to_jsonb(old);
    after_json := null;
    rec := to_jsonb(old);
  else
    before_json := to_jsonb(old);
    after_json := to_jsonb(new);
    rec := to_jsonb(new);
  end if;

  v_entity_id := nullif(rec->>'id', '')::uuid;

  if tg_table_name = 'organizations' then
    v_organization_id := nullif(rec->>'id', '')::uuid;
    v_facility_id := null;
  elsif tg_table_name = 'organization_module_settings' then
    v_organization_id := nullif(rec->>'organization_id', '')::uuid;
    v_facility_id := null;
  elsif tg_table_name = 'facilities' then
    v_facility_id := nullif(rec->>'id', '')::uuid;
    v_organization_id := nullif(rec->>'organization_id', '')::uuid;
  elsif tg_table_name = 'feature_flag_rules' then
    -- scope_id points at an org or a facility depending on scope_type.
    if rec->>'scope_type' = 'facility' then
      v_facility_id := nullif(rec->>'scope_id', '')::uuid;
      v_organization_id := null;
    else
      v_organization_id := nullif(rec->>'scope_id', '')::uuid;
      v_facility_id := null;
    end if;
  else
    v_facility_id := nullif(rec->>'facility_id', '')::uuid;
    v_organization_id := null;
  end if;

  -- Fallback for org-scoped tables (tenant_subscriptions, usage_counters) that
  -- carry organization_id but no facility_id.
  if v_facility_id is null and v_organization_id is null then
    v_organization_id := nullif(rec->>'organization_id', '')::uuid;
  end if;

  -- Null references whose parent has already been removed (cascade deletes),
  -- so the audit insert can never violate an FK.
  if v_facility_id is not null and not exists (select 1 from facilities where id = v_facility_id) then
    v_facility_id := null;
  end if;
  if v_organization_id is not null and not exists (select 1 from organizations where id = v_organization_id) then
    v_organization_id := null;
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not exists (select 1 from app_users where id = v_actor) then
    v_actor := null;
  end if;

  insert into audit_events (
    facility_id, organization_id, actor_user_id, event_type, entity_table, entity_id, event_payload
  ) values (
    v_facility_id,
    v_organization_id,
    v_actor,
    'config.changed',
    tg_table_name,
    v_entity_id,
    jsonb_build_object('before', before_json, 'after', after_json)
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists feature_flag_rules_audit_change on feature_flag_rules;
create trigger feature_flag_rules_audit_change
  after insert or update or delete on feature_flag_rules
  for each row execute function fn_audit_admin_change();

drop trigger if exists tenant_subscriptions_audit_change on tenant_subscriptions;
create trigger tenant_subscriptions_audit_change
  after insert or update or delete on tenant_subscriptions
  for each row execute function fn_audit_admin_change();
