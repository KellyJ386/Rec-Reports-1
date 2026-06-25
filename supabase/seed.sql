insert into permissions (code, description) values
  ('reports.read', 'Read daily reports'),
  ('reports.create', 'Create report drafts'),
  ('reports.submit', 'Submit final reports'),
  ('reports.export', 'Export reports'),
  ('schedule.read', 'Read schedules'),
  ('schedule.manage', 'Manage schedules'),
  ('training.read', 'Read training and certifications'),
  ('incidents.manage', 'Manage incidents'),
  ('admin.manage', 'Manage facility configuration'),
  ('reports.template.manage', 'Manage report templates')
on conflict (code) do nothing;

insert into organizations (id, name) values
  ('00000000-0000-0000-0000-000000000100', 'Demo Recreation Department')
on conflict (id) do nothing;

insert into facilities (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000100', 'North Arena', 'America/New_York'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000100', 'Riverfront Aquatics', 'America/New_York')
on conflict (id) do nothing;


insert into departments (id, facility_id, name, code) values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 'Aquatics', 'aquatics'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000201', 'Arena Operations', 'arena_ops')
on conflict (id) do nothing;

insert into report_templates (id, facility_id, department_id, code, name, description, status, active_version) values
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 'opening_checklist', 'Opening Checklist', 'Daily opening readiness report for aquatics operations.', 'published', 1)
on conflict (id) do nothing;

insert into report_template_versions (id, facility_id, template_id, version_number, schema_json, validation_json, workflow_json, is_published) values
  (
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000401',
    1,
    '{"sections":[{"title":"Opening checks","fields":[{"key":"pool_ready","label":"Pool ready","type":"select","required":true,"options":["pass","fail"]},{"key":"attendance","label":"Expected attendance","type":"number","required":true}]}]}'::jsonb,
    '{"submit_policy":"strict_block"}'::jsonb,
    '{"on_submit":["queue_pdf","notify_managers"]}'::jsonb,
    true
  )
on conflict (id) do nothing;


insert into employees (id, facility_id, department_id, employee_no, first_name, last_name) values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 'AQUA-001', 'Jordan', 'Lee'),
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 'AQUA-002', 'Riley', 'Patel')
on conflict (id) do nothing;

insert into certification_types (id, facility_id, code, name, renewal_window_days) values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000201', 'lifeguard', 'Lifeguard Certification', 45),
  ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000201', 'cpr', 'CPR/AED', 30)
on conflict (id) do nothing;

insert into employee_certifications (id, facility_id, employee_id, certification_type_id, issued_at, expires_at) values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000701', '2026-01-01', '2027-01-01'),
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000702', '2026-01-01', '2027-01-01')
on conflict (id) do nothing;

insert into schedule_periods (id, facility_id, department_id, week_start_date, week_end_date, status) values
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', '2026-07-06', '2026-07-12', 'draft')
on conflict (id) do nothing;

insert into schedule_shifts (id, facility_id, schedule_period_id, department_id, role_code, shift_date, starts_at, ends_at, source, status, required_certification_ids) values
  ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000301', 'lifeguard', '2026-07-06', '2026-07-06 09:00:00-04', '2026-07-06 13:00:00-04', 'manual', 'assigned', array['00000000-0000-0000-0000-000000000701'::uuid, '00000000-0000-0000-0000-000000000702'::uuid]),
  ('00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000301', 'cashier', '2026-07-06', '2026-07-06 12:00:00-04', '2026-07-06 16:00:00-04', 'manual', 'open', '{}')
on conflict (id) do nothing;

insert into shift_assignments (id, facility_id, shift_id, employee_id, status) values
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000601', 'approved')
on conflict (id) do nothing;
