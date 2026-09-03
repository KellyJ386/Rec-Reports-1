<!-- Evidence report generated 2026-09-03 by a Sonnet evaluation agent for REC_REPORTS_360_EVALUATION_AND_FINISH_PLAN.md; headline claims re-verified by the orchestrator. Screenshot and scratch paths referenced below were session-local and are not in the repo. -->

# Rec Reports — Front-End / UX Evaluation

Evaluated by running the production build (`npm run build` → `node scripts/server.mjs dist`, PORT=4300) with
placeholder Supabase/JWT env vars, driving headless Chromium via Playwright at desktop (1280×800) and mobile
(390×844) viewports. A valid HS256 JWT (`sub`=uuid, `role`/`aud`=authenticated, 5‑yr `exp`, signed with the
placeholder `SUPABASE_JWT_SECRET`) was minted and stored as `localStorage.rr_admin_token` to reach the
authenticated UI; `page.route()` intercepted `/api/v1/**` and `/api/admin/v1/**` to return plausible JSON so
each module panel could render with data (mock shapes matched against `src/lib/http/me-route.mjs`,
`reports-routes.mjs`'s `/reports/:id/detail`, and the field names read in `src/public/js/app.js`).

**Headline finding, discovered while testing, changes how every other result should be read:** the production
static file server (`scripts/server.mjs`, and `scripts/dev-server.mjs` too) serves `.mjs` files with
`Content-Type: text/plain` (its `contentTypes` map only has `.html`/`.css`/`.js` — see
`scripts/server.mjs:36`, `scripts/dev-server.mjs:7`). `src/public/js/app.js` is loaded as
`<script type="module">` and directly imports six sibling `.mjs` files
(`report-form.mjs`, `incident-form.mjs`, `list-pagination.mjs`, `work-order-filters.mjs`,
`schedule-board.mjs`, `comms-compose.mjs`). Browsers enforce strict MIME checking on module imports, so **every
one of those imports is rejected and `app.js` never executes, in any real browser, on `/`.** The admin app
(`/admin/js/app.js`) is unaffected because it only imports plain `.js` files. Net effect: **today, a real
visitor to `/` — signed in or not — sees a permanently static, data-free skeleton page** (see
`screens/auth-home-desktop-overview.png`): the facility switcher never populates, "Signed in as …" never
fills in, and none of the six module panels ever load, with **no error shown to the user** (only a silent
console MIME warning). All "module works / doesn't work" findings below therefore come from two passes:

- **Broken pass** (`unauth-*`, `auth-home-desktop-*`, `auth-home-mobile-*`, `auth-home-desktop-after-refresh`,
  `auth-admin-*`): the real, currently-shipping behavior — `/admin/` is unaffected and works; `/` is dead.
- **Fixed pass** (`fixed-*`): the same authenticated session with a `page.route("**/*.mjs")` shim that
  re-serves those six files with a corrected `Content-Type: text/javascript`, to evaluate the module UI the
  team actually built once it can run. This is the intended experience; it is not what ships.

Server logs, console-error dumps, and JWT/mock scripts are in this scratchpad (`server.log`,
`console-report.json`, `console-report-fixed.json`, `pwscratch/*.mjs`) for reproduction.

---

## 1) Scored criteria

### (a) Real create/edit/submit flow per module — **4/5** (once the MIME bug is fixed; **1/5** as shipped)
All six modules have genuine write flows wired to real endpoints, not just read-only lists:
- **Daily reports**: template list → "Fill out report" → schema-driven stepper-capable form (single-section
  template rendered flat; `state.currentSectionIndex` in `app.js` implies multi-section stepping works, not
  directly exercised here) with autosave (`AUTOSAVE_DELAY_MS`), Save draft / Submit, per-submission
  Attachments upload. `screens/fixed-reports-fill-form.png`.
- **Incidents**: "Report new incident" capture form (type/severity/occurred-at/location/summary/immediate
  actions/OSHA checkbox with severity-gated required fields) → detail view with Submit/Escalate/status-change,
  follow-ups (create/complete), escalation acknowledge/resolve, an explicitly-labeled immutable amendment
  history, and attachments. `screens/fixed-incidents-capture-form.png`,
  `screens/fixed-incidents-detail.png`.
- **Work orders**: filter chips (All/Open/Overdue/Mine) + priority filter → "New work order" create form
  (title/description/priority/asset/assignee/due date) → detail with status change, assignee reassignment,
  comment thread, attachments. `screens/fixed-work-orders-create-form.png`.
- **Scheduling**: week picker, "Create schedule period", generate-from-template/validate/publish actions,
  per-shift assign/unassign. `screens/fixed-scheduling.png`.
- **Communications**: "Compose message" (channel/subject/body/priority/required-ack/audience picker) →
  publish; delivery/read receipts fire automatically on open; acknowledge action on required-ack messages.
  `screens/fixed-comms-compose-form.png`.
- **Training/Certifications**: assignment cards with "Mark complete"; a read-only certification wallet
  (status/expiry/evidence-on-file) with **no upload control in the end-user UI** — evidence review is
  admin-side only (`screens/fixed-training.png`, `screens/fixed-certifications.png`).

Docked from 5: the "People involved / witness" section of the incident form is a stated placeholder in both
the code comment and the rendered UI ("Person/witness tracking isn't available in this release yet" —
`app.js` ~line 2151), no module has a genuine multi-step wizard as the design docs specify (see §4), and none
of this is reachable in the shipped build.

### (b) Mobile usability — **2/5**
- No horizontal scrolling anywhere tested (the one place that could have needed it, the 7-column schedule
  board, has a `@media (max-width: 900px)` rule collapsing it to one column — `styles.css:632`).
- Forms stack cleanly and are legible at 390px (`screens/fixed-mobile-report-form.png`,
  `screens/fixed-mobile-incident-form.png`).
- **Tap targets fail Apple/Google's 44×44px minimum almost everywhere**: measuring every visible
  button/select/input at 390px width, **32 of 34 interactive elements (94%) were under 44×44px** — most
  primary buttons measured 300×37px (height fails), and the work-order filter chips (All/Open/Overdue/Mine)
  measured as small as 48×30px.
- **The real content starts nearly three phone-screens down.** On mobile, `#reports-list` (the first actual
  module panel) sits at `y=2201px` and `#incidents-workspace` at `y=4090px` against an 844px viewport — i.e.
  2.6 and 4.8 full scrolls, respectively, past a marketing hero and six inert placeholder cards, before a
  frontline worker reaches anything functional (`screens/crop-mobile-fold.png`).

### (c) Accessibility basics — **3/5**
- Most form labels correctly wrap their control (`el("label", {}, ["Title", titleInput])` pattern used in
  work orders, comms, scheduling, report-form.mjs's schema fields with explicit `for`/`id`) — this is a valid
  accessible pattern.
- **Exception**: the incident capture form's `fieldRow()` helper (`app.js:1949-1955`) renders the `<label>`
  and its `<input>`/`<select>` as unassociated siblings with no `for`/`id` — six fields (Incident type,
  Severity, Occurred at, Location, Summary, Immediate actions) on the highest-stakes form in the app have no
  programmatic label association for screen readers.
- **Zero `aria-live` regions anywhere in `src/public/js/app.js`** (grep count: 0), despite loading states,
  inline errors, and autosave status changing constantly — a screen-reader user gets no announcement when a
  panel finishes loading, an error appears, or a draft autosaves. By contrast every admin page file
  (`src/public/admin/js/pages/*.js`) has exactly one `aria-live="polite"` status region — the admin surface
  was built with this in mind and the end-user surface was not.
- Keyboard: Tab order works, focus is visible (`outline: rgb(16,16,16) auto 1px` on the browser default,
  1px — present but thin and easy to miss against busy backgrounds), no custom focus-trap issues observed.
- No skip-link to jump past the hero/placeholder cards to the module content — compounds finding (b)'s scroll
  depth for keyboard/screen-reader users too.
- Severity/status is never color-only (always paired with text, e.g. "Status: draft"), so no colorblindness
  trap there.

### (d) Empty / error / loading states — **4/5**
Consistently implemented, if plain: every panel has a real empty-state sentence ("No incidents reported.",
"No follow-up actions yet.", "No schedule period exists yet for the week of 2026‑08‑31.",
"No certifications on file."), a `Loading…` placeholder, and inline `Error: <message>` text on failure
(`setLoading`/`setError`/`renderInlineError` in `app.js`). The 422 field-validation path
(`applyServerErrors`) maps server errors back onto individual fields rather than a single blob. Docked one
point only for the missing `aria-live` (state changes are visible but not announced) and for `setLoading`
replacing content with plain `innerHTML = '<p>Loading...</p>'` rather than a proper skeleton/spinner.

### (e) Navigation / IA: "3 taps to submit today's report or log an incident" — **1/5**
This is the single worst-scoring criterion, for two independent, compounding reasons:
1. **`/signin` unconditionally redirects every successful login to `/admin/`** (`src/public/signin/app.js:56`,
   `window.location.href = "/admin/"` — no branch on role or `platformAdmin`). There is no link anywhere in
   the admin shell (`src/public/admin/index.html`, checked for `href="/"`) back to the operations app at `/`.
   A frontline lifeguard signing in through the only sign-in page in the product lands in the Admin Control
   Center — module toggles, role editors, org settings — and has no in-app way back to "submit today's
   report." They'd have to know to hand-edit the URL.
2. Even starting from `/` directly, the real "Fill out report" button sits **2.6 mobile screens** down past a
   hero and six dead placeholder cards (see (b)); "Report new incident" is **4.8 screens** down. That's tap 1
   (facility already correct) + a long scroll + tap 2 — technically two taps, but nothing close to the
   roadmap's "3‑tap completion" *principle*, which is about total time-to-task, not literal tap count.
And this is all moot today anyway, since (a) the whole `/` app doesn't execute at all in production.

### (f) Visual consistency between `/`, `/signin`, `/admin` — **2/5**
Three visually distinct systems: `/signin` is a clean, centered card (good, but subtitled "Admin Control
Center," reinforcing finding (e) that this login is framed as admin-only even though it's the only login in
the product); `/admin/` is a proper app shell with a left sidebar, consistent panel cards, and a working
top-bar (screens `auth-admin-desktop-*`); `/` is a marketing-landing-page layout ("PRODUCTION READINESS
SPRINT 1" — literal internal sprint-planning copy shipped as end-user-facing hero text) with a completely
different type scale, card style, and color usage from both other surfaces. No shared header/nav component,
no shared logo treatment, no consistent button styling across the three (compare the pill-shaped signin
button to the admin/end-user rectangular buttons).

### (g) Offline / refresh behavior — **2/5**
- The bearer token correctly survives a hard refresh (`localStorage`, confirmed via harness).
- **Facility context does not.** Selecting a second facility ("Downtown Rec Center") in the end-user app's
  switcher, then hard-refreshing, silently reverts to the first facility in the list — `initialize()` always
  does `currentFacility = facilities[0].id` on load and never persists the user's choice. For a roving
  staff member who covers multiple sites, every refresh (or reopened tab) silently switches them back to
  facility #1, with no indication anything changed — a real risk of someone submitting a report or incident
  against the wrong facility. The admin app gets this right (`rr_admin_context` in `localStorage`,
  `src/public/admin/js/state.js`) — the fix pattern already exists in the codebase, just not applied to `/`.
- No offline banner/service worker/IndexedDB queue anywhere (design docs call for one — see §4); a network
  drop mid-form simply surfaces `apiFetch`'s generic "Network error: …" text with no retry/offline affordance.

---

## 2) Screenshots taken

All paths relative to `/tmp/claude-0/-home-user-Rec-Reports-1/c864b4df-9d12-50d2-bca2-92cd93177551/scratchpad/screens/`.

**Unauthenticated, real production behavior (desktop 1280×800 + mobile 390×844):**
| File | Shows |
|---|---|
| `unauth-signin-desktop.png` / `unauth-signin-mobile.png` | `/signin` login card |
| `unauth-home-desktop.png` / `unauth-home-mobile.png` | `/` with no token — static shell only |
| `unauth-admin-desktop.png` / `unauth-admin-mobile.png` | `/admin/` "No session token is set" empty state |

**Authenticated, real production behavior (the MIME bug is live — proves the app is dead):**
| File | Shows |
|---|---|
| `auth-home-desktop-overview.png` | `/` full page with a valid token+mocked API — still a data-free static skeleton |
| `auth-home-desktop-section-*.png` (reports-list, schedule-workspace, incidents-workspace, work-orders-workspace, comms-workspace, training-list, certifications-list) | Each module's DOM slot, empty |
| `auth-home-mobile-overview.png`, `auth-home-mobile-incidents.png` | Same, mobile |
| `auth-home-desktop-after-refresh.png` | Confirms nothing changes after reload |

**Authenticated, MIME-fixed pass (what the module UI actually looks like once it can run):**
| File | Shows |
|---|---|
| `fixed-auth-home-desktop-full.png` | Full `/` page, all 6 modules rendered with mock data |
| `fixed-reports-fill-form.png` | Daily report schema-driven fill form (Free Chlorine/pH/Notes) |
| `fixed-report-inbox.png` | Manager review inbox with filters |
| `fixed-scheduling.png` | Weekly schedule board, empty-state message |
| `fixed-incidents-capture-form.png` | Full incident capture form, severity-gated fields |
| `fixed-incidents-detail.png` | Incident detail: submit/escalate, follow-ups, escalation history, amendments |
| `fixed-work-orders-create-form.png` | Work order create form + filter chips |
| `fixed-comms-compose-form.png` | Message compose form with audience picker |
| `fixed-training.png` / `fixed-certifications.png` | Training assignments / certification wallet |
| `fixed-auth-home-mobile-full.png` | Full mobile page, working |
| `fixed-mobile-report-form.png` / `fixed-mobile-incident-form.png` | Report/incident forms at 390px |
| `crop-mobile-fold.png` | Above-the-fold mobile view — hero + facility switcher only, no functional content visible |
| `crop-mobile-incident-form-viewport.png` | Single-viewport (non-scrolled) crop of the mobile incident form |

**Admin Control Center (desktop 1280×800 + mobile 390×844, real production behavior — unaffected by the MIME bug):**
| File | Shows |
|---|---|
| `auth-admin-desktop-dashboard.png` | Dashboard (note: duplicated "Quick links" block — see defect #7) |
| `auth-admin-desktop-modules.png` | Module toggle matrix |
| `auth-admin-desktop-identity.png` | Roles/permissions/memberships (note: broken "Create a role" layout — defect #8) |
| `auth-admin-desktop-forms.png` | Form builder |
| `auth-admin-desktop-notifications.png` | Notification settings |
| `auth-admin-desktop-facilities.png` | Facilities & Departments CRUD |
| `auth-admin-desktop-certifications.png` | Certification admin |
| `auth-admin-desktop-branding.png` | Branding & documents |
| `auth-admin-desktop-audit.png` | Audit & compliance |
| `auth-admin-desktop-billing.png` | Billing & subscription |
| `auth-admin-mobile-dashboard.png` / `auth-admin-mobile-modules.png` | Same shell at 390px — sidebar nav does not collapse to a mobile pattern |

---

## 3) Top 10 UX defects, ranked by impact on a pilot facility

1. **The entire end-user app (`/`) never executes in a real browser.** `.mjs` sibling imports are served as
   `text/plain` by both `scripts/server.mjs` and `scripts/dev-server.mjs` (no `.mjs` entry in their
   `contentTypes` map), which browsers refuse to run as ES modules under strict MIME checking. A pilot
   facility deploying today gets a permanently blank, data-free shell at `/` with no visible error. This is a
   one-line fix (add `".mjs": "text/javascript"` to both files' `contentTypes` maps) but blocks 100% of the
   product's daily-use surface (reports, incidents, work orders, scheduling, comms, training) until fixed.
2. **Sign-in always drops every user into the Admin Control Center, with no path back to the operations
   app.** `src/public/signin/app.js:56` hard-codes `window.location.href = "/admin/"` regardless of role, and
   nothing in the admin shell links to `/`. Combined with #1, a frontline worker who successfully signs in
   today cannot reach "submit a report" through any UI path at all.
3. **Facility context silently resets on refresh.** `initialize()` always selects `facilities[0]` on load
   and never restores a prior selection; a staff member covering multiple facilities can unknowingly end up
   submitting a report or incident against the wrong site after any refresh/reopened tab. The admin app
   already solves this correctly (`rr_admin_context` in localStorage) — the pattern just wasn't reused.
4. **94% of mobile tap targets are under the 44×44px minimum**, and real content starts 2.6–4.8 screens down
   the page — on the device class this product is explicitly designed for ("mobile-first field operations,"
   per the roadmap), both the reach and the tap accuracy work against a lifeguard/pool-tech trying to log
   something quickly between other duties.
5. **No dashboard/triage view exists.** The roadmap's #2 MVP UI priority — "role-based home dashboard
   (today's shifts, overdue reports, open incidents/work orders)" — doesn't exist; `/` is a static marketing
   hero followed by a flat, un-prioritized stack of all six modules. Nothing surfaces what's overdue or urgent
   without scrolling through everything.
6. **Incident capture form fields have no programmatic label association** (`app.js:1949-1955`) — a
   screen-reader user filling out an incident report (plausibly under time pressure, plausibly the exact
   scenario where accessibility matters most) gets unlabeled form controls on the app's most consequential
   form.
7. **Admin dashboard renders a duplicated "Quick links" panel** under rapid/overlapping navigation to the
   same route — `renderDashboard` has no render-generation guard, so an in-flight async render (the
   `/org/:id/facilities` fetch) can still append its own copy of the static "Quick links" block after a
   second render of the same route has already populated the container. Reproducible by navigating to
   Dashboard while a previous Dashboard render's network call is still in flight (slow network, double-click).
8. **The Identity & Permissions "Create a role" form has a broken layout** — the permission checkbox list
   floats far right of its own "Role name" input and "Add role" button, with a large dead whitespace gap
   between them (`auth-admin-desktop-identity.png`), on the page every admin will use to set up a new
   facility's permission model.
9. **No global search**, despite being an explicit roadmap UX principle ("unified global search for people,
   shifts, incidents, work orders") — there's no way to jump to a specific incident, work order, or person
   without navigating into the right module and scanning/filtering a list.
10. **Zero `aria-live` regions in the entire end-user app** — loading, error, and autosave-status changes are
    all visually-only; a screen-reader user gets no notification when a form finishes saving, a panel
    finishes loading, or a submit fails.

---

## 4) Top 5 improvements, with rough size

1. **Fix the `.mjs` Content-Type bug** in `scripts/server.mjs` and `scripts/dev-server.mjs` — the single
   highest-leverage fix in the whole codebase; unblocks the entire end-user app. **Size: S** (one line each,
   two files, plus a smoke test that `/` actually executes JS in a real browser — the existing test suite
   apparently never caught this because it doesn't render in a browser).
2. **Route sign-in by role, and add a way back to `/` from `/admin/`.** Branch `signin/app.js`'s redirect on
   whether the signed-in user is a platform admin / has `admin.manage` (data already available from
   `/api/v1/me`'s `platformAdmin`/`permissions`), defaulting non-admins to `/`; add a persistent "Back to
   operations" link in the admin top bar regardless. **Size: S–M**.
3. **Build the roadmap's "role-based home dashboard"**: replace the static hero + placeholder-card stack at
   the top of `/` with a real triage view — today's shifts, overdue reports, open incidents/work orders —
   and move the marketing copy below it or remove it. This directly fixes the mobile scroll-depth problem
   (defect #4) and the missing-dashboard problem (defect #5) at once, and is explicitly called for in
   `PHASED_MVP_ROADMAP.md` §6.1. **Size: M**.
4. **Persist facility selection** (mirror `src/public/admin/js/state.js`'s `rr_admin_context` pattern into
   `src/public/js/app.js`) and **raise mobile tap targets to ≥44×44px** (buttons/chips currently 30–37px
   tall) via a CSS pass on `styles.css`'s button/chip rules. **Size: S** each, bundle together as one PR.
5. **Accessibility pass on the incident capture form + add `aria-live` status regions app-wide**: fix
   `fieldRow()` in `app.js` to wrap inputs in their `<label>` (or add `for`/`id`, matching the pattern already
   used correctly elsewhere in the same file), and add one `aria-live="polite"` status region per panel
   (the admin app's own `pages/facilities.js` `status-region` pattern can be copied directly). **Size: S–M**.

---

## 5) Roadmap / design-doc comparison

**`PHASED_MVP_ROADMAP.md` §6 (UI Priorities) vs. reality:**

| §6.1 MVP UI sequence item | Status |
|---|---|
| 1. Login + facility context switch | Exists, but login always exits to `/admin/` (defect #2) and facility context doesn't survive refresh (defect #3) |
| 2. Role-based home dashboard (today's shifts, overdue reports, open incidents/work orders) | **Missing** — `/` is a static hero + flat module list, not a triage view |
| 3. Fast-entry forms (report, incident, work order) | Built and functional (once JS runs), but buried 2.6–4.8 mobile screens down |
| 4. Schedule board | Built — day-column board, responsive collapse under 900px |
| 5. Communication inbox/channel view with ack actions | Built — message list + acknowledge action, though not a dedicated unread/inbox view |

| §6.2 UX principle | Status |
|---|---|
| Mobile-first field operations design | **Not met** — 94% of tap targets under 44px, real content scrolled far below the fold |
| "3-tap completion" for common tasks | **Not met** — see criterion (e); currently 0-tap (app doesn't run) in production |
| High-visibility badges for urgent/non-compliant items | Partially met — status/severity text+color exist per-item, but nothing aggregates them for at-a-glance triage (no dashboard) |
| Unified global search | **Missing entirely** |

**Module design docs vs. reality** (each doc's UI section):
- `DAILY_REPORTS_MODULE_DESIGN.md` §8.1 asked for a stepper with progress indicator, **sticky** Save/Submit
  bar, inline camera capture, and a touch signature pad. Reality: a flat single-section form in this test
  (multi-section stepping logic exists in code but wasn't exercised), Save/Submit buttons scroll with the
  page rather than sticking, and there's a generic file-upload "Attachments" control instead of dedicated
  camera/signature widgets.
- `INCIDENT_ACCIDENT_REPORTING_SYSTEM.md` §3.1 asked for a 6-step wizard including "Who was involved" and
  "Witness statements." Reality: one flat form with all fields on screen at once, and the app itself labels
  the witness/people-involved section "not available in this release."
- `SCHEDULING_SYSTEM_DESIGN.md` §3 asked for a Week Grid / Day Timeline / Open Shift Board with a
  conflict/certification-warning panel, plus employee self-service (My Schedule, pick up shifts, request
  swap, submit time off, availability editor) and a printable weekly PDF. Reality: one day-column board for
  managers; **none** of the employee self-service flows or PDF export exist in the end-user UI.
- `COMMUNICATION_TRAINING_SYSTEM_DESIGN.md` §9 asked for a unified "My Queue" (acks + assigned training +
  expiring certs + SOP attestations) and a course player with resume/chapters/quiz feedback. Reality: three
  separate, unmerged panels (messages / training assignments / certifications), and "training assignment"
  cards carry no course title, content, or player — just a due date and a "Mark complete" button.
- `MASTER_ADMIN_CONTROL_CENTER_DESIGN.md` §2: the 10-group nav and most key pages (Modules & Features,
  Identity & Permissions, Facilities & Departments) match the design closely and are functionally solid — the
  best-matched design doc of the set. The one gap: §2.2(A)'s Dashboard called for a "configuration health
  score," "unpublished changes queue," "expiring certifications," and "recent critical admin actions"; the
  built dashboard only shows three static counts and a (currently duplicated, defect #7) quick-links list.

---

## Reproduction notes
- Server: `npm run build`, then `PORT=4300 SUPABASE_URL=http://localhost:4399 SUPABASE_ANON_KEY=x
  SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_JWT_SECRET=0123456789abcdef0123456789abcdef
  APP_URL=http://localhost:4300 OBSERVABILITY_DSN=https://example.invalid/o node scripts/server.mjs dist`
  — started cleanly, no fallback to `npm run dev` was needed. **Server was stopped at the end of this
  evaluation.**
- Playwright 1.49.1 installed to `pwscratch/node_modules` (outside the repo), driven with the preinstalled
  Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- Scripts: `pwscratch/eval.mjs` (unauth + real-broken-behavior pass), `pwscratch/eval2.mjs` (MIME-fixed pass),
  `pwscratch/crops.mjs` / `pwscratch/offsets.mjs` / `pwscratch/refresh-fixed.mjs` (tap-target measurement,
  scroll-depth measurement, facility-persistence check).
