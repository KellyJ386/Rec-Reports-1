# Master Admin Control Center Design
## Recreation Operations SaaS Platform

## 1) Architecture

### 1.1 Goals
The Master Admin Control Center (MACC) is the centralized governance plane for multi-facility recreation operations. It must allow tenant admins to configure modules, policies, forms, notifications, permissions, branding, and subscription controls without engineering support.

### 1.2 Layered architecture
1. **Admin Experience Layer (Web + Mobile-Responsive)**
   - Global admin shell with tenant/facility/department context switcher.
   - Policy-driven page visibility based on role permissions.
   - Draft/publish UX for safe configuration rollout.

2. **Admin API / BFF Layer**
   - Typed config endpoints (`/api/admin/v1/*`).
   - Read-through cache for frequently accessed config.
   - Mutation pipeline with validation, versioning, and audit emission.

3. **Configuration Domain Services**
   - Module & Feature Management Service.
   - Identity & RBAC Service.
   - Form and Custom Field Service.
   - Notification Routing Service.
   - Certification Policy Service.
   - Branding & Template Service.
   - Subscription & Entitlements Service.

4. **Policy/Rules Engine**
   - Evaluates effective configuration at runtime:
     - tenant-level defaults,
     - facility overrides,
     - department overrides,
     - role-based constraints,
     - subscription entitlement gates.

5. **Data Layer**
   - PostgreSQL for config + audit + permissions.
   - Object storage for logos/theme assets/PDF templates.
   - Search index for audit and config discovery.

6. **Eventing + Observability**
   - Outbox-driven config events (`config.changed`, `module.toggled`, etc.).
   - Immutable audit stream.
   - Metrics for admin operations and policy evaluation latency.

### 1.3 Control center domains
- **Platform Controls**: module toggles, feature flags, subscription/entitlements.
- **Org Controls**: facilities, departments, distribution lists, notification routes.
- **Compliance Controls**: certifications, retraining policies, audit trails.
- **Experience Controls**: branding, PDF templates, form builder, custom fields.

---

## 2) Admin UI Layout

### 2.1 Global shell
- Top bar: tenant selector, facility scope, environment badge, global search, alerts.
- Left nav groups:
  1. Dashboard
  2. Modules & Features
  3. Identity & Permissions
  4. Forms & Fields
  5. Notifications
  6. Facilities & Departments
  7. Certifications
  8. Branding & Documents
  9. Audit & Compliance
  10. Billing & Subscription

### 2.2 Key pages

#### A) Dashboard
- Configuration health score.
- Unpublished changes queue.
- Expiring certifications and failed notification routes.
- Recent critical admin actions.

#### B) Modules & Features
- Module toggle matrix (rows=modules, columns=scopes).
- Feature flag table with rollout percentage/target filters.
- Impact preview (“This disables scheduling API access for 3 departments”).

#### C) Identity & Permissions
- Role catalog (system + custom).
- Permission graph explorer (`module.resource.action`).
- Effective access simulator (user x facility x department).

#### D) Forms & Fields
- Drag/drop form builder.
- Custom field registry.
- Field dependency rules and validation policy editor.
- Version compare + rollback.

#### E) Notifications
- Routing policies by event type/severity.
- Distribution list manager.
- Channel health and provider fallback settings.
- Test notification sandbox.

#### F) Facilities & Departments
- Facility profiles (timezone, locale, operations calendar, defaults).
- Department policy overrides.
- Inheritance visualization (tenant default → facility override → department override).

#### G) Certifications
- Certification type lifecycle settings.
- Role-to-cert requirements matrix.
- Retraining cadence and grace policy editor.

#### H) Branding & Documents
- Theme editor (colors, typography, logos).
- White-label settings (domain/email signatures).
- PDF template designer and versioning.

#### I) Audit & Compliance
- Searchable audit timeline.
- Diff view for configuration changes.
- Export package (PDF/CSV/JSON) for compliance audits.

#### J) Billing & Subscription
- Plan summary and entitlement usage.
- Add-on management.
- Overage alerts and projected billing impact.

---

## 3) Schema

### 3.1 Core tenancy and scope
- `tenants(id, name, status, plan_id, created_at)`
- `facilities(id, tenant_id, name, timezone, locale, status, settings_jsonb)`
- `departments(id, facility_id, name, status, settings_jsonb)`

### 3.2 Modules and feature flags
- `modules(id, code, name, category, default_enabled)`
- `tenant_module_settings(id, tenant_id, module_id, enabled, config_jsonb, updated_by, updated_at)`
- `facility_module_overrides(id, facility_id, module_id, enabled nullable, config_patch_jsonb, updated_by, updated_at)`
- `feature_flags(id, key, description, rollout_type, default_state)`
- `feature_flag_rules(id, feature_flag_id, scope_type, scope_id, rule_jsonb, state, starts_at, ends_at)`

### 3.3 RBAC and permissions
- `roles(id, tenant_id nullable, code, name, is_system_role, active)`
- `permissions(id, code, module_code, action, description)`
- `role_permissions(id, role_id, permission_id, effect)`
- `user_role_assignments(id, user_id, role_id, scope_type, scope_id, starts_at, ends_at)`
- `permission_constraints(id, role_id, constraint_jsonb)`

### 3.4 Forms and custom fields
- `custom_fields(id, tenant_id, entity_type, key, label, data_type, validation_jsonb, active)`
- `form_definitions(id, tenant_id, module_code, form_code, version_no, status, schema_jsonb, created_by)`
- `form_field_bindings(id, form_definition_id, field_key, display_order, required, conditional_rule_jsonb)`
- `form_publications(id, form_definition_id, scope_type, scope_id, published_at, published_by)`

### 3.5 Notifications and distribution lists
- `notification_events(id, code, severity, module_code, default_channels_jsonb)`
- `distribution_lists(id, tenant_id, name, scope_type, scope_id, description)`
- `distribution_list_members(id, distribution_list_id, member_type, member_ref_id)`
- `notification_routes(id, tenant_id, event_code, priority, route_jsonb, active)`
- `notification_route_overrides(id, scope_type, scope_id, event_code, route_patch_jsonb, active)`

### 3.6 Facility/department settings
- `facility_settings(id, facility_id, settings_jsonb, version, published_at)`
- `department_settings(id, department_id, settings_jsonb, version, published_at)`
- `config_inheritance_snapshots(id, tenant_id, scope_type, scope_id, resolved_settings_jsonb, generated_at)`

### 3.7 Certification management
- `certification_types(id, tenant_id, code, name, validity_days, renewal_window_days, grace_days, active)`
- `certification_role_requirements(id, certification_type_id, role_id, required_level, enforcement_mode)`
- `certification_policies(id, tenant_id, trigger_type, cadence_rule, action_jsonb, active)`

### 3.8 Branding and PDF templates
- `branding_profiles(id, tenant_id, name, theme_jsonb, logo_file_id, is_default, updated_at)`
- `pdf_templates(id, tenant_id, template_code, version_no, engine_type, layout_jsonb, css_blob, active)`
- `pdf_template_bindings(id, template_id, module_code, document_type, scope_type, scope_id)`

### 3.9 Subscription management
- `subscription_plans(id, code, name, base_price, billing_period, feature_entitlements_jsonb)`
- `tenant_subscriptions(id, tenant_id, plan_id, status, starts_at, renews_at, seat_limit, usage_limits_jsonb)`
- `subscription_addons(id, code, name, pricing_model, entitlement_patch_jsonb)`
- `tenant_addons(id, tenant_subscription_id, addon_id, quantity, status)`
- `usage_counters(id, tenant_id, metric_code, period_start, period_end, value)`

### 3.10 Audit logs
- `audit_logs(id bigserial, tenant_id, actor_user_id, action_code, scope_type, scope_id, entity_type, entity_id, before_jsonb, after_jsonb, request_id, ip_address, user_agent, created_at)`
- `audit_signatures(id, audit_log_id, signature_alg, signature_value, key_id, signed_at)`

---

## 4) Permission Hierarchy

### 4.1 Hierarchical scopes
1. **Platform scope** (vendor/internal super admin).
2. **Tenant scope** (organization-wide admin).
3. **Facility scope**.
4. **Department scope**.
5. **Self scope** (end-user limited actions).

### 4.2 Role model
- **System roles**: Tenant Owner, Compliance Admin, Ops Admin, Billing Admin, Read-Only Auditor.
- **Custom roles**: tenant-defined roles with bounded permission sets.
- Permissions encoded as `module.resource.action` (e.g., `training.assignment.publish`).

### 4.3 Policy evaluation order
1. Verify subscription entitlement allows target action.
2. Evaluate explicit deny rules.
3. Apply role grants at nearest scope.
4. Apply inherited grants from parent scope.
5. Apply contextual constraints (time, department, shift, certification status).
6. Return decision + reason code for explainability.

---

## 5) Configuration Workflows

### 5.1 Module toggle workflow
- Draft change → dependency validation → impact simulation → approval (optional) → publish.
- Auto-generated rollback checkpoint.

### 5.2 Role and permission workflow
- Create/update role → attach permissions → run access simulation tests → approval → publish.

### 5.3 Form builder workflow
- Build form in draft → validate schema → test with sample payloads → version publish to scope.

### 5.4 Notification routing workflow
- Define event route → set escalation chain → run test notification across channels → activate.

### 5.5 Certification policy workflow
- Configure certification type and expiry → map to roles/departments → set retraining and enforcement actions → publish.

### 5.6 Branding and PDF workflow
- Edit theme/template draft → preview against sample records → publish by scope with version lock.

---

## 6) Scalability Recommendations

1. **Config read optimization**
   - Precompute resolved config snapshots per scope.
   - Cache hot configs in Redis with event-driven invalidation.

2. **Write-path safety**
   - Use optimistic locking (`version` columns) for concurrent admin edits.
   - Batch non-critical recalculations asynchronously.

3. **Event-driven fanout**
   - Publish config change events and allow modules to refresh asynchronously.

4. **Partitioning strategy**
   - Partition `audit_logs` by month/tenant for scale.
   - Archive old config versions to cold storage after retention window.

5. **Multi-region posture**
   - Primary write region + read replicas near user concentrations.
   - Optional active-active for notification endpoints only.

---

## 7) Tenant Isolation Strategy

- Shared DB with strict row-level security (RLS) on every tenant table.
- Mandatory `tenant_id` on all domain entities; `facility_id`/`department_id` scoped beneath tenant.
- Access predicate pattern:
  - `tenant_id IN (SELECT tenant_id FROM user_memberships WHERE user_id = auth.uid())`
- Tenant-specific encryption context for sensitive configuration blobs.
- Storage isolation:
  - object keys prefixed by `tenant/{tenant_id}/...`
  - signed URL issuance gated by scope checks.
- No cross-tenant joins in runtime query paths.

---

## 8) Audit Logging Strategy

### 8.1 What to log
- All admin mutations:
  - module toggles,
  - permission changes,
  - form/schema publishes,
  - notification route updates,
  - branding/template publishes,
  - subscription changes.

### 8.2 Event shape
- Actor, scope, action code, entity, before/after snapshot, correlation/request ID.
- Source metadata: IP, user agent, API client, session ID.

### 8.3 Integrity and compliance
- Append-only write model.
- Hash-chain or signed records for tamper evidence.
- Retention policy tiers (e.g., 1 year hot, 6 years archive).
- Export and legal hold controls.

### 8.4 Observability
- Real-time alerts for risky actions:
  - granting high-privilege roles,
  - disabling critical modules,
  - deleting distribution lists tied to emergency routing.

---

## 9) Onboarding Workflow

1. **Tenant provisioning**
   - Create tenant + default plan + baseline module set.
2. **Branding bootstrap**
   - Upload logo, set theme, configure domain/email signatures.
3. **Facility and department setup**
   - Import facilities/departments (CSV/API) and set local defaults.
4. **Identity bootstrap**
   - Invite admins and assign initial roles.
5. **Policy setup wizard**
   - Permissions, notification routing, distribution lists, certifications.
6. **Form/template setup**
   - Choose starter templates for incidents, daily reports, training attestations.
7. **Dry-run validation**
   - Run readiness checks and test notifications.
8. **Go-live publish**
   - Promote draft config to active and capture onboarding snapshot.

---

## 10) Subscription Tier Logic

### 10.1 Entitlement dimensions
- Enabled modules (training, incidents, scheduling integration, advanced reporting).
- Limits (facilities, active users, forms, custom fields, storage, SMS volume).
- Advanced capabilities (feature flags UI, audit export API, SSO, custom PDF engine).

### 10.2 Example tier model
- **Essentials**
  - Core communications, basic forms, standard branding, limited audit retention.
- **Professional**
  - Adds advanced training/certifications, custom fields, notification routing policies, facility overrides.
- **Enterprise**
  - Adds advanced feature flags, SSO/SCIM, compliance exports, enhanced audit retention, dedicated support.

### 10.3 Enforcement logic
- Runtime entitlement guard checks before every privileged action.
- Soft-limit warnings (80/90/100%) with self-serve upgrade prompts.
- Hard enforcement for disallowed capabilities; graceful degradation for overages based on plan policy.

### 10.4 Billing-aware admin UX
- Show current usage against limits in each relevant admin page.
- Inline “unlock with upgrade” CTA on gated controls.
- Forecast panel for projected costs when enabling add-ons or increasing limits.
