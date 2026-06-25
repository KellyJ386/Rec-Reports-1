insert into permissions (code, description) values
  ('reports.read', 'Read daily reports'),
  ('reports.create', 'Create report drafts'),
  ('reports.submit', 'Submit final reports'),
  ('reports.export', 'Export reports'),
  ('schedule.read', 'Read schedules'),
  ('schedule.manage', 'Manage schedules'),
  ('training.read', 'Read training and certifications'),
  ('training.manage', 'Manage training and certifications'),
  ('incidents.read', 'Read incidents'),
  ('incidents.manage', 'Manage incidents'),
  ('work_orders.read', 'Read work orders'),
  ('work_orders.manage', 'Manage work orders'),
  ('admin.manage', 'Manage facility configuration'),
  ('reports.template.manage', 'Manage report templates'),
  ('communications.read', 'Read communications'),
  ('communications.publish', 'Publish communications')
  ('incidents.read', 'Read incidents'),
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


insert into incident_reports (id, facility_id, department_id, incident_no, report_type, status, severity, occurred_at, location_text, summary, immediate_actions, requires_osha_review) values
  ('00000000-0000-0000-0000-000000001201', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 'INC-2026-0001', 'accident', 'escalated', 'high', '2026-07-06 10:15:00-04', 'North pool deck', 'Guest slipped on wet pool deck near lane 3.', 'Area closed, first aid provided, supervisor notified.', true)
on conflict (id) do nothing;

insert into incident_people (id, facility_id, incident_id, person_role, full_name, injury_json, statement_text) values
  ('00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000001201', 'injured_party', 'Demo Guest', '{"body_part":"ankle","first_aid":true}'::jsonb, 'I slipped while walking near the pool deck.')
on conflict (id) do nothing;

insert into incident_escalations (id, facility_id, incident_id, reason_code, target_role, due_at) values
  ('00000000-0000-0000-0000-000000001401', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000001201', 'high_severity', 'facility_manager', '2026-07-06 12:15:00-04')
on conflict (id) do nothing;

insert into incident_followup_actions (id, facility_id, incident_id, action_type, status, due_at, description) values
  ('00000000-0000-0000-0000-000000001501', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000001201', 'corrective_action', 'open', '2026-07-07 17:00:00-04', 'Review pool deck mats and wet floor signage placement.')
on conflict (id) do nothing;


insert into assets (id, facility_id, department_id, asset_tag, name, location_text) values
  ('00000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 'POOL-DECK-01', 'Pool deck safety mats', 'North pool deck')
on conflict (id) do nothing;

insert into work_orders (id, facility_id, department_id, asset_id, source_type, source_id, title, description, priority, status, assigned_to_employee_id, due_at) values
  ('00000000-0000-0000-0000-000000001701', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000001601', 'incident', '00000000-0000-0000-0000-000000001201', 'Review pool deck mats', 'Review pool deck mats and wet floor signage after accident INC-2026-0001.', 'high', 'open', '00000000-0000-0000-0000-000000000602', '2026-07-07 17:00:00-04')
on conflict (id) do nothing;

insert into work_order_updates (id, facility_id, work_order_id, update_type, body, new_value) values
  ('00000000-0000-0000-0000-000000001801', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000001701', 'status_change', 'Work order opened from incident follow-up.', 'open')
on conflict (id) do nothing;


insert into communication_channels (id, facility_id, department_id, channel_type, name, emergency_enabled) values
  ('00000000-0000-0000-0000-000000001901', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', 'department', 'Aquatics Operations', true)
on conflict (id) do nothing;

insert into messages (id, facility_id, channel_id, author_employee_id, message_type, subject, body_text, priority, is_required_ack, ack_due_at, published_at) values
  ('00000000-0000-0000-0000-000000002001', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000001901', '00000000-0000-0000-0000-000000000601', 'announcement', 'Pool deck safety reminder', 'Review wet floor signage placement before each shift.', 'urgent', true, '2026-07-06 18:00:00-04', '2026-07-06 11:00:00-04')
on conflict (id) do nothing;

insert into message_audiences (id, facility_id, message_id, audience_type, audience_ref_id) values
  ('00000000-0000-0000-0000-000000002101', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000002001', 'department', '00000000-0000-0000-0000-000000000301')
on conflict (id) do nothing;

insert into message_receipts (id, facility_id, message_id, employee_id, delivered_at, read_at) values
  ('00000000-0000-0000-0000-000000002201', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000002001', '00000000-0000-0000-0000-000000000601', '2026-07-06 11:00:10-04', '2026-07-06 11:04:00-04')
on conflict (id) do nothing;

insert into message_acknowledgements (id, facility_id, message_id, employee_id, ack_state) values
  ('00000000-0000-0000-0000-000000002301', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000002001', '00000000-0000-0000-0000-000000000601', 'pending')
on conflict (id) do nothing;


insert into courses (id, facility_id, code, title, description, status) values
  ('00000000-0000-0000-0000-000000002401', '00000000-0000-0000-0000-000000000201', 'POOL_DECK_SAFETY', 'Pool Deck Safety Refresher', 'Required refresher after pool deck slip incidents.', 'published')
on conflict (id) do nothing;

insert into course_modules (id, facility_id, course_id, module_type, title, order_no, content_jsonb) values
  ('00000000-0000-0000-0000-000000002501', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000002401', 'checklist', 'Wet floor signage checklist', 1, '{"items":["Inspect mats","Place signage","Log hazards"]}'::jsonb)
on conflict (id) do nothing;

insert into training_assignments (id, facility_id, employee_id, course_id, due_at, reason_code, source_type, source_ref_id) values
  ('00000000-0000-0000-0000-000000002601', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000002401', '2026-07-13 17:00:00-04', 'incident_followup', 'incident_rule', '00000000-0000-0000-0000-000000001201')
on conflict (id) do nothing;

insert into training_progress (id, facility_id, assignment_id, module_id, state) values
  ('00000000-0000-0000-0000-000000002701', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000002601', '00000000-0000-0000-0000-000000002501', 'not_started')
on conflict (id) do nothing;


insert into modules (id, code, name, category, default_enabled) values
  ('00000000-0000-0000-0000-000000002801', 'daily_reports', 'Daily Reports', 'operations', true),
  ('00000000-0000-0000-0000-000000002802', 'scheduling', 'Scheduling', 'operations', true),
  ('00000000-0000-0000-0000-000000002803', 'incidents', 'Incidents', 'risk', true),
  ('00000000-0000-0000-0000-000000002804', 'work_orders', 'Work Orders', 'maintenance', true),
  ('00000000-0000-0000-0000-000000002805', 'communications', 'Communications', 'engagement', true),
  ('00000000-0000-0000-0000-000000002806', 'training', 'Training', 'compliance', true)
on conflict (id) do nothing;

insert into facility_settings (id, facility_id, settings_jsonb, version, published_at) values
  ('00000000-0000-0000-0000-000000002901', '00000000-0000-0000-0000-000000000201', '{"locale":"en-US","reporting":{"dailyReportDueHour":18},"notifications":{"quietHoursStart":"22:00","quietHoursEnd":"06:00"}}'::jsonb, 1, now())
on conflict (id) do nothing;

insert into branding_profiles (id, facility_id, name, theme_jsonb, is_default) values
  ('00000000-0000-0000-0000-000000003001', '00000000-0000-0000-0000-000000000201', 'North Arena Default', '{"primary":"#1c6dd0","accent":"#9ec5a9"}'::jsonb, true)
on conflict (id) do nothing;

insert into admin_change_requests (id, facility_id, entity_table, entity_id, change_summary, after_jsonb, status) values
  ('00000000-0000-0000-0000-000000003101', '00000000-0000-0000-0000-000000000201', 'facility_settings', '00000000-0000-0000-0000-000000002901', 'Publish initial facility operating defaults.', '{"version":1}'::jsonb, 'published')
on conflict (id) do nothing;
