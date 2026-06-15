# CLAUDE.md — RecReports

> Project constitution. Every agent working in this repo reads this file first and obeys it over any conflicting instruction in a task prompt. If a task prompt contradicts this file, stop and flag it.

---

## 1. What RecReports is

RecReports is a multi-tenant SaaS platform for **recreation facility operations management** — daily documentation, compliance reporting, and employee scheduling in one system. It serves campus recreation, municipal parks & rec, YMCAs, fitness centers, aquatic centers, and multi-sport complexes.

It is the operations layer. It does **not** do registration, booking, POS, or payment processing — it runs alongside those tools.

The two modules that differentiate RecReports from every competitor are **Employee Scheduling** and the **Staff Certifications Tracker** (cert-aware scheduling). Protect their quality above all else.

---

## 2. Tech stack (do not substitute without approval)

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS |
| Database | Supabase (PostgreSQL) with Row-Level Security |
| Auth | Supabase Auth (SSO via SAML 2.0 for enterprise) |
| Offline | Dexie.js (IndexedDB) |
| Client state | Zustand |
| File storage | Supabase Storage |
| Scheduling UI | react-big-calendar |
| Email | Resend (`noreply@send.recreports.com`) |
| Billing | Stripe (annual subscriptions only) |
| Hosting | Vercel |

**No tRPC. No AI features in the product. No GraphQL.** Data access is Next.js Server Actions and Route Handlers against Supabase.

---

## 3. Hard constraints (non-negotiable)

1. **`facility_id` is always injected server-side** from the authenticated session. It is **never** read from a client request body, query param, or header. A client that sends `facility_id` is ignored.
2. **No hardcoded admin-configurable values.** Severity levels, categories, areas, cert types, job areas, count types, incident categories, etc. live in database config tables and are edited in the Admin Control Center. Ship defaults via seed/migration, never as literals in app code.
3. **No photo/image documentation in Injury/Illness or Incident records.** Narrative + structured fields only. (Liability/privacy decision — do not "improve" this.)
4. **No AI-generated content in any record.** Operational and compliance data is human-authored and auditable.
5. **RLS on every facility-scoped table.** No table holding tenant data ships without an RLS policy. A migration that creates such a table without RLS is incomplete.
6. **`SECURITY DEFINER` functions are used sparingly and reviewed individually.** Default to `SECURITY INVOKER`. Every definer function needs a comment justifying it.
7. **Admin-first dependency rule.** A module may not be built before the admin config tables it reads from exist and are seeded.

---

## 4. Brand & design tokens

| Token | Value |
|---|---|
| Primary (Forest Green) | `#1B4332` |
| Accent (Amber) | `#D97706` |
| Navy (headings) | `#1E3A5F` |
| Success/active | derive from Forest Green |
| Surface / neutral grays | Tailwind `gray-*` scale |

- Mobile-first. Staff complete reports on phones/tablets on the floor.
- **Color is never the only signal.** Conflict/status indicators carry a text or icon label, not just red/yellow/green (accessibility + colorblind safety).
- Display/body type: a sturdy geometric sans (Inter or Plus Jakarta Sans). No ice/rink imagery — this is not RinkReports.

---

## 5. Role hierarchy (5 tiers)

Each tier inherits the permissions below it. Enforced in RLS, not just UI.

| Role | Scope |
|---|---|
| `super_admin` | Platform operator (RecReports staff). Cross-org. Not a customer role. |
| `org_admin` | Manages a multi-facility organization. Creates facilities, assigns managers, org-wide reporting. |
| `facility_manager` | Full control of one facility: config, users, all records, schedule publish. |
| `supervisor` | Creates/reviews reports, assigns tasks, edits schedules. No config, no user management. |
| `staff` | Creates reports, completes assigned work, views own schedule, submits availability/swaps. |

Staff see only records they authored; supervisors and managers see facility-wide.

---

## 6. Database conventions

- Every facility-scoped table has a non-null `facility_id uuid references facility(id)`.
- Org-scoped tables carry `org_id`. The tenancy chain is `organization → facility → everything`.
- Snake_case table and column names. Plural is avoided; use singular entity names (`shift`, `injury_report`).
- Timestamps stored in **UTC** (`timestamptz`), displayed in the facility's configured time zone.
- Every table has `id uuid default gen_random_uuid()`, `created_at`, `updated_at`, and where a user authors it, `created_by uuid references user_account(id)`.
- **Migrations are append-only and reviewed.** Use timestamp-based migration names. Never edit a migration that has been applied to remote. (Lesson from RinkReports migration reconciliation pain.)
- Polymorphic children (persons involved, witnesses) use `parent_id` + `parent_type` and are guarded by RLS that resolves the parent's `facility_id`.

### RLS pattern (every facility-scoped table)

```sql
-- read: members of the facility
create policy "read_own_facility" on <table>
  for select using (
    facility_id in (
      select facility_id from facility_membership
      where user_id = auth.uid()
    )
  );
-- write: role-gated via a helper that checks facility_membership.role
```

Use a single audited SQL helper (`current_user_role_at(facility_id)`) rather than repeating role logic.

---

## 7. Status-flow vocabulary (report modules)

`Draft → Submitted → Reviewed → Closed`

- **Draft**: editable by author, invisible to reviewers.
- **Submitted**: locked to author, visible to supervisor/manager.
- **Reviewed**: a supervisor/manager has acknowledged it.
- **Closed**: read-only for all; reopening requires manager override (audited).

---

## 8. Non-functional baseline (applies to every module)

- **Offline**: documentation modules (reports, tasks, log, forms) capture offline via Dexie and sync on reconnect with a visible sync indicator. Records are append-only where possible; editable records use last-write-wins **with a conflict flag surfaced to a manager — never a silent overwrite.** Scheduling publish and cert enforcement require connectivity.
- **Retention**: Injury/Incident reports retained ≥7 years, never hard-deleted within the window. Other records 3 years, configurable. Cert history retained indefinitely. Hard-delete only on org offboarding via `super_admin` with an audit entry.
- **Audit log**: every create/edit/status-change/lock/unlock/export on a report record writes an immutable audit row (who, what, when, before/after). Append-only; not editable by any customer role.
- **Accessibility**: WCAG 2.1 AA — keyboard nav, visible focus, contrast, screen-reader labels on all fields.
- **PII**: names, contact info, DOB in reports encrypted at rest.

---

## 9. Agent delegation pattern

| Model | Use for |
|---|---|
| **Haiku** | Mechanical, pattern-following work: CRUD UI scaffolding, config list/edit screens, repetitive form fields, migration boilerplate derived from an existing pattern. |
| **Sonnet** | Security-sensitive or stateful logic: RLS policies, `SECURITY DEFINER` functions, auth flows, the scheduling conflict engine, cert enforcement, polymorphic-record access, cross-module links, the final security audit. |

A Haiku-built table or screen that touches tenant data gets a **Sonnet RLS review** before it's considered done.

---

## 10. Folder conventions

```
/app                 # Next.js App Router routes
  /(admin)           # Admin Control Center (facility_manager+)
  /(modules)         # operational modules
  /api               # route handlers
/components          # shared UI
/lib
  /supabase          # server + browser clients, typed
  /auth              # session, role helpers
  /offline           # Dexie schema + sync
/db
  /migrations        # timestamp-named SQL migrations
  /seed              # default config values (admin-configurable defaults)
/types               # generated Supabase types + domain types
```

---

## 11. Definition of done (every task)

- [ ] TypeScript strict, no `any` without justification.
- [ ] Every new facility-scoped table has an RLS policy + is added to seed where it holds defaults.
- [ ] `facility_id` server-injected; verified not trusted from client.
- [ ] Admin-configurable values read from config tables, not literals.
- [ ] Mobile layout works; keyboard + focus states present.
- [ ] Audit entries written for report state changes.
- [ ] Generated Supabase types updated.
- [ ] Sonnet RLS review completed if the task touched tenant data.

---

## 12. Intentionally NOT built

Payment processing / POS / registration · in-app chat threads · photo docs in incident/injury records · deep BI dashboards (export to CSV/PDF instead) · any AI feature. Naming these is a design decision, not a backlog gap. Do not add them.
</content>
