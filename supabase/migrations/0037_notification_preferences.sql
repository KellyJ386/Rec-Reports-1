-- ===========================================================================
-- 0037_notification_preferences.sql
-- CM-07 (plans/COMMUNICATIONS_PLAN.md): device token registration + the
-- per-employee notification-preferences table the push delivery channel
-- needs, neither of which existed in 0006.
--
--   * employee_device_tokens   -- one row per registered push token (a
--     device can hold more than one active token across app reinstalls, so
--     this is NOT a one-row-per-employee table). Unique on `token` itself
--     (not per-employee) so the CM-07 route layer can upsert
--     ("re-registering the same token updates last_seen_at rather than
--     duplicating") with a single onConflict="token" insert. `revoked_at`
--     is nullable and set (never hard-deleted) both when an employee
--     explicitly revokes a token via DELETE /me/device-tokens/:id and when
--     the push adapter (src/lib/notifications/push.mjs) reports a token as
--     permanently rejected by the provider -- the worker only ever needs
--     "is this token currently active", which `revoked_at is null` answers
--     without losing the token's history.
--   * employee_notification_preferences -- one row per employee (unique on
--     (facility_id, employee_id)) carrying per-channel opt-in flags plus an
--     optional personal quiet-hours override (quiet_hours_start/end,
--     "HH:MM" text exactly like the reports.quietHoursStart/End setting-
--     registry keys src/lib/admin/notifications.mjs' isWithinQuietHours
--     already consumes). A missing row means "every channel enabled, no
--     personal override" -- the route layer synthesizes that default rather
--     than requiring a persisted row per employee.
--
-- RLS follows the 0025_communications_self_service_rls.sql convention
-- exactly: self-service read/write for the OWNING employee
-- (employees.user_id = auth.uid(), joined via employees.id = <table>.employee_id
-- with a facility_id match), consistency-checked against the referenced
-- employees row via fn_assert_same_facility(facility_id, 'employees',
-- employee_id) (0009's generic cross-tenant FK guard, here pointed at
-- `employees` as the "parent" instead of `messages`), plus an additive
-- manage-level policy for communications.publish holders (e.g. an admin
-- revoking a departed employee's stale token, or setting a manager_override
-- style preference on someone else's behalf) -- Postgres RLS ORs permissive
-- policies together, so self-service and publisher-manage compose exactly
-- like message_receipts/message_acknowledgements already do.
--
-- Idempotent throughout: `create table if not exists`, `drop policy if
-- exists` immediately preceding each `create policy` (required from 0009
-- onward by scripts/verify-migrations.mjs).
-- ===========================================================================

create table if not exists employee_device_tokens (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'web')),
  token text not null unique,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists employee_notification_preferences (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references facilities(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  in_app_enabled boolean not null default true,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default true,
  push_enabled boolean not null default true,
  quiet_hours_start text check (quiet_hours_start is null or quiet_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_hours_end text check (quiet_hours_end is null or quiet_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, employee_id)
);

create index if not exists employee_device_tokens_employee_idx on employee_device_tokens(facility_id, employee_id) where revoked_at is null;
create index if not exists employee_notification_preferences_employee_idx on employee_notification_preferences(facility_id, employee_id);

alter table employee_device_tokens enable row level security;
alter table employee_notification_preferences enable row level security;

-- ---------------------------------------------------------------------------
-- employee_device_tokens: self-service (own row only) + publisher manage.
-- ---------------------------------------------------------------------------
drop policy if exists "employees can manage their own device tokens" on employee_device_tokens;
create policy "employees can manage their own device tokens" on employee_device_tokens
  for all using (
    fn_assert_same_facility(facility_id, 'employees', employee_id)
    and exists (
      select 1 from employees e
      where e.id = employee_device_tokens.employee_id
        and e.facility_id = employee_device_tokens.facility_id
        and e.user_id = auth.uid()
    )
  ) with check (
    fn_assert_same_facility(facility_id, 'employees', employee_id)
    and exists (
      select 1 from employees e
      where e.id = employee_device_tokens.employee_id
        and e.facility_id = employee_device_tokens.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "communication publishers can manage device tokens" on employee_device_tokens;
create policy "communication publishers can manage device tokens" on employee_device_tokens
  for all using (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  );

-- ---------------------------------------------------------------------------
-- employee_notification_preferences: same shape.
-- ---------------------------------------------------------------------------
drop policy if exists "employees can manage their own notification preferences" on employee_notification_preferences;
create policy "employees can manage their own notification preferences" on employee_notification_preferences
  for all using (
    fn_assert_same_facility(facility_id, 'employees', employee_id)
    and exists (
      select 1 from employees e
      where e.id = employee_notification_preferences.employee_id
        and e.facility_id = employee_notification_preferences.facility_id
        and e.user_id = auth.uid()
    )
  ) with check (
    fn_assert_same_facility(facility_id, 'employees', employee_id)
    and exists (
      select 1 from employees e
      where e.id = employee_notification_preferences.employee_id
        and e.facility_id = employee_notification_preferences.facility_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "communication publishers can manage notification preferences" on employee_notification_preferences;
create policy "communication publishers can manage notification preferences" on employee_notification_preferences
  for all using (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  ) with check (
    has_permission(auth.uid(), facility_id, 'communications.publish')
    and fn_assert_same_facility(facility_id, 'employees', employee_id)
  );
