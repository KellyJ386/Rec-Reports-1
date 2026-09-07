// DR-21/DR-22 (plans/DAILY_REPORTS_PLAN.md) -- report distribution.
//
// Composes the existing notification primitives instead of forking a
// parallel recipient/routing stack (see 0054_report_distribution.sql's
// header for the full composition-vs-split justification):
//   - expandDistributionList / isWithinQuietHours (src/lib/admin/
//     notifications.mjs) are reused unchanged, exactly like
//     src/lib/notifications/worker.mjs already reuses them for the generic
//     routed-event pipeline.
//   - in_app/push deliveries are handed off to that SAME
//     notification_jobs pipeline (a single-recipient job per leg), so
//     quiet-hours-per-employee-preference, device-token resolution, and the
//     push adapter are never reimplemented here -- only email is genuinely
//     new (report_deliveries + src/lib/notifications/email.mjs).
//
// Recipient resolution (DR-21, pure, tested in isolation):
//   resolveReportRecipients({ binding, members, employees, memberships })
//     expands the binding's bound distribution list via
//     expandDistributionList against CURRENT membership (same "fresher than
//     an enqueue-time snapshot" rationale worker.mjs's
//     expandRouteRecipients already documents), then narrows by the
//     binding's own department_id/role_id when set, dedupes by employee id,
//     and never resolves an employee/membership/list-member row that does
//     not carry the binding's own facility_id -- even if the caller passes
//     a mixed-facility roster by mistake, cross-facility rows are dropped
//     before expansion ever runs.
//
// Delivery drain (DR-22): processReportSubmittedEvents(client, {adapters,
// now, limit, config}) claims 'report.submitted' outbox_events rows (see
// src/lib/notifications/worker.mjs's RESERVED_OUTBOX_EVENT_TYPES for why
// this file -- not drainOutboxOnce -- is the one claiming them), resolves
// each submission's active distribution bindings, fans out one
// report_deliveries row per (binding, recipient, channel), and:
//   - email: sent immediately via src/lib/notifications/email.mjs sendEmail
//     (subject "<template name> - <report date>", body summarizing the
//     submission with a link, attach_pdf resolved to a PDF link when
//     pdf_status='generated' or a "will follow" note otherwise -- real PDF
//     BYTE attachment is DR-23/out of scope, see the module doc below).
//   - in_app/push: handed off to notification_jobs (see above).
//   - digest=true bindings' email legs are buffered and merged into ONE
//     email per (facility, recipient) covering every submission resolved
//     in THIS drain pass -- see the "digest batching" comment on
//     runDigestSends below for the documented simplification (no persistent
//     digest-state table in this cut).
//   - quiet hours (reports.quietHoursStart/End, reused from the registry)
//     defer the WHOLE claimed batch to the window's end, same
//     reschedule-not-fail semantics as worker.mjs's processJob.
//   - retry/bounce is tracked at OUTBOX-EVENT granularity (outbox_events
//     has next_attempt_at/attempts; report_deliveries does not) with an
//     idempotent re-attempt: a report_deliveries row already 'sent'/
//     'bounced'/'skipped' (the unique (submission_id,
//     report_distribution_list_id, recipient_employee_id, channel) index)
//     is never re-inserted or re-sent when its event retries, so a retry
//     only ever (re)attempts the legs that are still outstanding.

import { pgSelect, pgInsert, pgUpdate } from "./supabase-rest.mjs";
import { expandDistributionList, isWithinQuietHours } from "./admin/notifications.mjs";
import { configValue } from "./settings-registry.mjs";
import { sendEmail } from "./notifications/email.mjs";
import { nextQuietWindowEnd } from "./notifications/worker.mjs";
import { reportError } from "./observability.mjs";

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2 * 60 * 1000; // 2 minutes
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

const OUTBOX_COLUMNS =
  "id,facility_id,event_type,payload,status,attempts,available_at,processed_at,last_error,next_attempt_at,created_at";
const BINDING_COLUMNS =
  "id,facility_id,template_id,distribution_list_id,department_id,role_id,channel,attach_pdf,digest,active,created_at,updated_at,deleted_at";
const SUBMISSION_COLUMNS = "id,facility_id,department_id,template_id,report_date,shift_ref,status,pdf_status";
const TEMPLATE_COLUMNS = "id,facility_id,name,code";
const DELIVERY_COLUMNS =
  "id,facility_id,submission_id,report_distribution_list_id,recipient_employee_id,channel,status,provider_message_id,attempts,last_error,created_at,sent_at";

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toHHMM(date) {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function computeBackoffMs(attempts) {
  const exponential = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exponential, MAX_BACKOFF_MS);
}

// --- DR-21: pure recipient resolution ---------------------------------------

// Builds { role_id -> [employee_id, ...] } from memberships (role_id,
// user_id) joined against employees (user_id -> id), exactly the pattern
// src/lib/http/communications-routes.mjs's loadAudienceResolutionContext
// already establishes for role -> employee expansion elsewhere in this
// codebase.
function buildRoleAssignments(memberships, employees) {
  const employeeIdByUserId = new Map(
    (employees ?? []).filter((employee) => employee?.user_id).map((employee) => [employee.user_id, employee.id])
  );
  return (memberships ?? [])
    .filter((membership) => membership?.status === undefined || membership.status === "active")
    .map((membership) => ({
      role_id: membership.role_id,
      employee_id: employeeIdByUserId.get(membership.user_id) ?? null
    }))
    .filter((assignment) => assignment.employee_id);
}

// Expands a template->distribution-list binding into a deduped array of
// employee ids, never reaching outside the binding's own facility_id:
//   1. Every members/employees/memberships row not carrying the binding's
//      facility_id is dropped BEFORE expansion (never merely filtered from
//      the final result), so a caller that accidentally passes a
//      mixed-facility roster can never leak a cross-facility employee id.
//   2. expandDistributionList (the existing 0016 pure helper) is composed,
//      never reimplemented, against CURRENT membership.
//   3. When the binding carries department_id and/or role_id, the expanded
//      set is narrowed to employees matching BOTH (an employee must satisfy
//      every constraint the binding sets, not just one).
//   4. Deduped by employee id (expandDistributionList already dedupes
//      internally; the department/role narrowing re-maps through employee
//      rows, so a final dedupe pass guards against a caller passing
//      duplicate employee rows for the same id).
export function resolveReportRecipients({ binding, members = [], employees = [], memberships = [] } = {}) {
  const facilityId = binding?.facility_id ?? null;
  if (!facilityId || !binding?.distribution_list_id) return [];

  const scopedEmployees = (employees ?? []).filter((employee) => employee?.facility_id === facilityId);
  const scopedMemberships = (memberships ?? []).filter((membership) => membership?.facility_id === facilityId);
  const scopedMembers = (members ?? []).filter((member) => member?.facility_id === facilityId);

  const roleAssignments = buildRoleAssignments(scopedMemberships, scopedEmployees);
  const list = { id: binding.distribution_list_id };
  const expandedIds = expandDistributionList(list, scopedMembers, {
    employees: scopedEmployees,
    roleAssignments
  });

  const employeeById = new Map(scopedEmployees.map((employee) => [employee.id, employee]));
  const roleEmployeeIds = binding.role_id
    ? new Set(
        roleAssignments.filter((assignment) => assignment.role_id === binding.role_id).map((assignment) => assignment.employee_id)
      )
    : null;

  const seen = new Set();
  const result = [];
  for (const employeeId of expandedIds) {
    if (seen.has(employeeId)) continue;
    const employee = employeeById.get(employeeId);
    if (!employee) continue;
    if (binding.department_id && employee.department_id !== binding.department_id) continue;
    if (roleEmployeeIds && !roleEmployeeIds.has(employeeId)) continue;
    seen.add(employeeId);
    result.push(employeeId);
  }
  return result;
}

// --- DR-22: pure message builders --------------------------------------

// "<template name> - <report date>" per the plan's exact subject shape.
export function buildDeliverySubject(template, submission) {
  return `${template?.name ?? "Report"} – ${submission?.report_date ?? "unknown date"}`;
}

function reportLink(appUrl, submissionId) {
  return `${String(appUrl ?? "").replace(/\/+$/, "")}/reports/${submissionId}`;
}

// attach_pdf policy: a link to the PDF once it exists (pdf_status =
// 'generated'), otherwise a note that it will follow -- real PDF byte
// attachment is DR-23/out of scope (no Storage-backed pdf path column
// exists on report_submissions yet; see 0054's header).
function pdfLine(appUrl, submission) {
  if (submission?.pdf_status === "generated") {
    return `PDF: ${reportLink(appUrl, submission.id)}/pdf`;
  }
  return "PDF: will be attached once generated.";
}

// Body for a single, immediate (non-digest) email delivery.
export function buildImmediateEmailText({ submission, template, binding, appUrl }) {
  const lines = [
    `A new "${template?.name ?? "report"}" was submitted for ${submission?.report_date ?? "an unknown date"}` +
      (submission?.shift_ref ? ` (shift ${submission.shift_ref})` : "") +
      "."
  ];
  lines.push(`View: ${reportLink(appUrl, submission?.id)}`);
  if (binding?.attach_pdf) lines.push(pdfLine(appUrl, submission));
  return lines.join("\n");
}

// Digest subject/body: one email per recipient per drain pass, listing
// every submission resolved to them across every 'report.submitted' outbox
// event this drain call processed (see runDigestSends below for why this is
// scoped to "this drain pass", not a calendar day).
export function buildDigestSubject(entries) {
  return `Report digest – ${entries.length} submission${entries.length === 1 ? "" : "s"}`;
}

export function buildDigestText({ entries, appUrl }) {
  return entries
    .map(({ submission, template, binding }) => {
      const line = [
        `${template?.name ?? "Report"} (${submission?.report_date ?? "unknown date"}): ${reportLink(appUrl, submission?.id)}`
      ];
      if (binding?.attach_pdf) line.push(`  ${pdfLine(appUrl, submission)}`);
      return line.join("\n");
    })
    .join("\n\n");
}

// --- DR-22: claim -----------------------------------------------------------

// Mirrors worker.mjs's claimDueOutboxEvents exactly, filtered to
// event_type='report.submitted' -- the type worker.mjs's own claim reserves
// away from itself (RESERVED_OUTBOX_EVENT_TYPES) specifically so this claim
// can see it.
export async function claimDueReportSubmittedEvents({ client, now = new Date(), limit = 25 }) {
  const nowIso = toIso(now);
  const candidates = await pgSelect(client, "outbox_events", {
    filters: { status: "pending", event_type: "report.submitted" },
    select: OUTBOX_COLUMNS,
    order: "available_at.asc",
    limit,
    extra: { or: `(available_at.lte.${nowIso},next_attempt_at.lte.${nowIso})` }
  });

  const claimed = [];
  for (const event of candidates ?? []) {
    const updated = await pgUpdate(
      client,
      "outbox_events",
      { id: event.id, status: "pending" },
      { status: "processing" },
      { returning: true }
    );
    if (Array.isArray(updated) && updated.length > 0) {
      claimed.push(updated[0]);
    }
    // else: lost the race to another concurrent drain -- skip it.
  }
  return claimed;
}

// --- DR-22: per-event resolution --------------------------------------

// Loads everything needed to resolve one event's legs (submission,
// template, active bindings, and each binding's recipients), or returns
// { skip: reason } for an event that has nothing to fan out (defensive
// against the payload shape this file consumes but does not produce --
// see the module doc: another builder's submit route is what actually
// writes these rows).
async function resolveEventLegs({ client, event }) {
  const payload = event.payload ?? {};
  const submissionId = payload.submission_id;
  const templateId = payload.template_id;
  if (!submissionId || !templateId || !event.facility_id) {
    return { skip: "malformed report.submitted payload (missing submission_id/template_id/facility_id)" };
  }
  // payload.facility_id (per the documented shape) is advisory -- the
  // outbox_events row's own facility_id COLUMN is what every downstream
  // query trusts and filters on. A payload that disagrees with its own
  // row's facility_id is malformed (never trusted enough to even guess
  // which facility it meant), not silently reconciled.
  if (payload.facility_id !== undefined && payload.facility_id !== event.facility_id) {
    return { skip: "report.submitted payload.facility_id does not match the outbox row's own facility_id" };
  }

  const submissionRows = await pgSelect(client, "report_submissions", {
    filters: { id: submissionId, facility_id: event.facility_id },
    select: SUBMISSION_COLUMNS,
    limit: 1
  });
  const submission = (submissionRows ?? [])[0] ?? null;
  if (!submission) return { skip: `report_submissions ${submissionId} not found for facility ${event.facility_id}` };

  const bindings = await pgSelect(client, "report_distribution_lists", {
    filters: { facility_id: event.facility_id, template_id: templateId, active: true },
    select: BINDING_COLUMNS,
    extra: { deleted_at: "is.null" }
  });
  if (!bindings || bindings.length === 0) {
    return { skip: `no active report_distribution_lists bindings for template ${templateId}` };
  }

  const templateRows = await pgSelect(client, "report_templates", {
    filters: { id: templateId, facility_id: event.facility_id },
    select: TEMPLATE_COLUMNS,
    limit: 1
  });
  const template = (templateRows ?? [])[0] ?? null;

  const [members, employees, memberships] = await Promise.all([
    pgSelect(client, "distribution_list_members", {
      filters: { facility_id: event.facility_id },
      select: "id,facility_id,distribution_list_id,member_type,member_ref_id"
    }),
    pgSelect(client, "employees", {
      filters: { facility_id: event.facility_id },
      select: "id,facility_id,department_id,user_id"
    }),
    pgSelect(client, "memberships", {
      filters: { facility_id: event.facility_id, status: "active" },
      select: "user_id,facility_id,role_id"
    })
  ]);

  // Email needs a real address; employees carries no email column of its
  // own (0003) -- an employee's address is app_users.email, reached via
  // employees.user_id. A scheduling-only employee with no linked user_id
  // (never signed in) has no resolvable address at all; that is handled
  // per-leg below (skipped, not attempted/failed) rather than here, since
  // in_app/push legs for the very same employee still resolve fine without
  // one.
  const userIds = [...new Set((employees ?? []).map((employee) => employee.user_id).filter(Boolean))];
  const appUsers =
    userIds.length > 0
      ? await pgSelect(client, "app_users", { filters: { id: { in: userIds } }, select: "id,email" })
      : [];
  const emailByUserId = new Map((appUsers ?? []).map((user) => [user.id, user.email]));
  const emailByEmployeeId = new Map(
    (employees ?? [])
      .filter((employee) => employee.user_id && emailByUserId.has(employee.user_id))
      .map((employee) => [employee.id, emailByUserId.get(employee.user_id)])
  );

  const legs = [];
  for (const binding of bindings) {
    const recipientIds = resolveReportRecipients({
      binding,
      members: members ?? [],
      employees: employees ?? [],
      memberships: memberships ?? []
    });
    for (const employeeId of recipientIds) {
      legs.push({
        event,
        submission,
        template,
        binding,
        employeeId,
        channel: binding.channel,
        recipientEmail: emailByEmployeeId.get(employeeId) ?? null
      });
    }
  }

  if (legs.length === 0) {
    return { skip: "every active binding resolved to zero recipients" };
  }
  return { legs };
}

// --- DR-22: delivery-row bookkeeping ------------------------------------

function legKey(leg) {
  return `${leg.submission.id}|${leg.binding.id}|${leg.employeeId}|${leg.channel}`;
}

const TERMINAL_STATUSES = new Set(["sent", "bounced", "skipped"]);

// Loads existing report_deliveries rows for every submission a batch of
// legs references, and inserts a fresh 'queued' row for any leg that has
// none yet. Returns { legs -> delivery row } via mutating each leg with a
// `.delivery` property, so the send phase never has to re-derive it.
async function attachDeliveryRows({ client, legs, config }) {
  const submissionIds = [...new Set(legs.map((leg) => leg.submission.id))];
  const existingRows =
    submissionIds.length > 0
      ? await pgSelect(client, "report_deliveries", {
          filters: { submission_id: { in: submissionIds } },
          select: DELIVERY_COLUMNS
        })
      : [];
  const existingByKey = new Map(
    (existingRows ?? []).map((row) => [`${row.submission_id}|${row.report_distribution_list_id}|${row.recipient_employee_id}|${row.channel}`, row])
  );

  const toInsert = [];
  for (const leg of legs) {
    const existing = existingByKey.get(legKey(leg));
    if (existing) {
      leg.delivery = existing;
    } else {
      toInsert.push(leg);
    }
  }

  if (toInsert.length > 0) {
    const rows = toInsert.map((leg) => ({
      facility_id: leg.event.facility_id,
      submission_id: leg.submission.id,
      report_distribution_list_id: leg.binding.id,
      recipient_employee_id: leg.employeeId,
      channel: leg.channel,
      status: "queued",
      attempts: 0
    }));
    const inserted = await pgInsert(client, "report_deliveries", rows, { returning: true });
    (inserted ?? rows).forEach((row, index) => {
      toInsert[index].delivery = row;
    });
  }

  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (const leg of legs) {
    const status = leg.delivery.status;
    leg.terminal = TERMINAL_STATUSES.has(status) || (status === "failed" && leg.delivery.attempts >= maxAttempts);
    leg.needsAttempt = !leg.terminal;
  }
}

// Applies a channel-specific outcome to one leg's report_deliveries row,
// returning the patch actually written (so the caller can log/inspect it).
async function applyOutcome({ client, leg, outcome, providerMessageId, code, nowIso, maxAttempts }) {
  const attempts = (leg.delivery.attempts ?? 0) + 1;
  let patch;
  if (outcome === "sent") {
    patch = { status: "sent", provider_message_id: providerMessageId ?? null, attempts, sent_at: nowIso, last_error: null };
  } else if (outcome === "permanent") {
    patch = { status: "bounced", attempts, last_error: code ?? "permanent provider rejection" };
  } else {
    // retryable
    const bounced = attempts >= maxAttempts;
    patch = { status: bounced ? "bounced" : "failed", attempts, last_error: code ?? "retryable provider failure" };
  }
  const rows = await pgUpdate(client, "report_deliveries", { id: leg.delivery.id }, patch, { returning: true });
  leg.delivery = (rows ?? [])[0] ?? { ...leg.delivery, ...patch };
  leg.terminal = leg.delivery.status !== "failed";
  return patch;
}

// Hands an in_app/push leg off to the existing notification_jobs pipeline
// (a single-recipient job) so worker.mjs's own drain delivers it -- device-
// token resolution, per-employee quiet-hours preference, and the push
// adapter are reused unchanged rather than reimplemented here. The
// report_deliveries row is marked 'sent' the moment the handoff job is
// queued: per 0054's header, this ledger records "did DR-22 fan this
// submission out to this recipient/channel", not the generic pipeline's own
// terminal delivery status (that lives in notification_deliveries, keyed
// off the job this inserts, not off report_deliveries -- there is no FK
// between the two tables).
async function handOffToNotificationJobs({ client, leg, nowIso }) {
  const job = {
    facility_id: leg.event.facility_id,
    event_type: "report.distributed",
    status: "pending",
    payload_jsonb: {
      recipients: [leg.employeeId],
      channels: [leg.channel],
      title: buildDeliverySubject(leg.template, leg.submission),
      body: buildImmediateEmailText({ submission: leg.submission, template: leg.template, binding: leg.binding, appUrl: "" }),
      submission_id: leg.submission.id,
      report_distribution_list_id: leg.binding.id
    }
  };
  await pgInsert(client, "notification_jobs", [job], { returning: true });
  const rows = await pgUpdate(
    client,
    "report_deliveries",
    { id: leg.delivery.id },
    { status: "sent", sent_at: nowIso, last_error: null },
    { returning: true }
  );
  leg.delivery = (rows ?? [])[0] ?? { ...leg.delivery, status: "sent", sent_at: nowIso };
  leg.terminal = true;
}

// Email legs whose recipient has no resolvable app_users.email (a
// scheduling-only employee who never signed in, see resolveEventLegs) can
// never be sent -- marked 'skipped' (terminal, no attempts spent) rather
// than fed to the adapter as a doomed 'failed' retry. Returns the legs that
// DO have an address, i.e. what the caller should actually attempt.
async function skipEmailLegsWithoutAddress({ client, legs }) {
  const sendable = [];
  for (const leg of legs) {
    if (leg.recipientEmail) {
      sendable.push(leg);
      continue;
    }
    const rows = await pgUpdate(
      client,
      "report_deliveries",
      { id: leg.delivery.id },
      { status: "skipped", last_error: "no linked email address for recipient" },
      { returning: true }
    );
    leg.delivery = (rows ?? [])[0] ?? { ...leg.delivery, status: "skipped" };
    leg.terminal = true;
  }
  return sendable;
}

// Sends every non-digest email leg immediately, one adapter call per leg.
async function runImmediateEmailSends({ client, legs, adapters, appUrl, now, maxAttempts }) {
  const nowIso = toIso(now);
  const sendable = await skipEmailLegsWithoutAddress({ client, legs });
  for (const leg of sendable) {
    const text = buildImmediateEmailText({ submission: leg.submission, template: leg.template, binding: leg.binding, appUrl });
    const subject = buildDeliverySubject(leg.template, leg.submission);
    const result = await sendEmail({ to: leg.recipientEmail, subject, text }, adapters?.email ? { adapter: adapters.email } : {});
    await applyOutcome({
      client,
      leg,
      outcome: result.outcome,
      providerMessageId: result.providerMessageId,
      code: result.code,
      nowIso,
      maxAttempts
    });
  }
}

// DR-22 digest batching (documented simplification, per the plan's own
// fallback: "or use a simpler rule and document it"): NO persistent
// digest-state table is added in this cut. A recipient's digest window is
// exactly "every 'report.submitted' outbox event resolved to them across
// THIS drain pass" -- i.e. the digest interval equals the drain cadence
// (e.g. every 5 minutes under a tight cron), not a calendar day/hour. This
// is deliberately conservative: it can only ever UNDER-batch (send more,
// smaller emails than a true once-daily digest would), never lose or
// duplicate a submission, and every digest leg still goes through the same
// idempotent report_deliveries dedup as an immediate send. A real
// once-daily digest (DR-27's "digest mode/hour" setting) would need a
// report_delivery_digests table recording each recipient's last-sent
// watermark -- left for that task, noted here rather than half-built.
async function runDigestSends({ client, legs, adapters, appUrl, now, maxAttempts }) {
  const nowIso = toIso(now);
  const sendable = await skipEmailLegsWithoutAddress({ client, legs });
  const groups = new Map();
  for (const leg of sendable) {
    const key = `${leg.event.facility_id}|${leg.employeeId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(leg);
  }

  for (const groupLegs of groups.values()) {
    const entries = groupLegs.map((leg) => ({ submission: leg.submission, template: leg.template, binding: leg.binding }));
    const subject = buildDigestSubject(entries);
    const text = buildDigestText({ entries, appUrl });
    const result = await sendEmail(
      { to: groupLegs[0].recipientEmail, subject, text },
      adapters?.email ? { adapter: adapters.email } : {}
    );
    for (const leg of groupLegs) {
      await applyOutcome({
        client,
        leg,
        outcome: result.outcome,
        providerMessageId: result.providerMessageId,
        code: result.code,
        nowIso,
        maxAttempts
      });
    }
  }
}

// --- DR-22: outbox-event finalization ------------------------------------

async function finalizeEvent({ client, event, legs, now, maxAttempts, config }) {
  const nowIso = toIso(now);
  const allTerminal = legs.every((leg) => leg.terminal);
  if (allTerminal) {
    await pgUpdate(
      client,
      "outbox_events",
      { id: event.id },
      { status: "processed", processed_at: nowIso, last_error: null },
      { returning: true }
    );
    return "processed";
  }

  const attempts = Number(event.attempts ?? 0) + 1;
  const exhausted = attempts >= maxAttempts;
  const patch = {
    attempts,
    last_error: "one or more deliveries are still retryable",
    status: exhausted ? "failed" : "pending",
    next_attempt_at: exhausted ? null : toIso(new Date(now.getTime() + computeBackoffMs(attempts)))
  };
  await pgUpdate(client, "outbox_events", { id: event.id }, patch, { returning: true });
  if (exhausted) {
    reportError(new Error(`report.submitted event ${event.id} exhausted retries with undelivered legs`), {
      dsn: config.dsn,
      fetchImpl: config.observabilityFetch,
      route: "report-distribution/drain",
      status: "failed",
      requestId: event.id,
      userId: null
    });
  }
  return exhausted ? "failed" : "retried";
}

async function skipEvent({ client, event, reason, now }) {
  await pgUpdate(
    client,
    "outbox_events",
    { id: event.id },
    { status: "processed", processed_at: toIso(now), last_error: `skipped: ${reason}` },
    { returning: true }
  );
}

// --- DR-22: entry point -------------------------------------------------

// processReportSubmittedEvents(client, {adapters, now, limit, config}) --
// called from the internal CRON_SECRET-guarded drain (src/lib/http/
// internal-routes.mjs) AFTER the generic notification worker's drainAll, so
// a submission's fan-out lands in the same drain invocation as everything
// else. `adapters.email` is an optional email adapter (src/lib/
// notifications/email.mjs's shape); omitted, sendEmail's own noopAdapter is
// used (see that file's header for why -- Slice 2C's real provider has not
// landed on this branch). `config.appUrl` builds the report link in every
// email body (falls back to "" -- an empty-origin relative link -- when
// unset, never throws).
export async function processReportSubmittedEvents({ client, adapters = {}, now = new Date(), limit = 25, config = {} }) {
  const summary = { claimed: 0, processed: 0, skipped: 0, retried: 0, failed: 0, rescheduled: 0 };
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const appUrl = config.appUrl ?? "";

  const claimed = await claimDueReportSubmittedEvents({ client, now, limit });
  summary.claimed = claimed.length;
  if (claimed.length === 0) return summary;

  // Quiet hours (reused from the daily-reports registry keys, same
  // reschedule-not-fail semantics as worker.mjs's processJob): applied to
  // the whole claimed batch at once, since the window is time-of-day only,
  // not per-facility -- matching processJob's own global-window design.
  const quietStart = config.quietHoursStart ?? configValue({}, "reports.quietHoursStart");
  const quietEnd = config.quietHoursEnd ?? configValue({}, "reports.quietHoursEnd");
  if (isWithinQuietHours(toHHMM(now), quietStart, quietEnd)) {
    const nextAttemptAt = toIso(nextQuietWindowEnd(now, quietEnd));
    for (const event of claimed) {
      await pgUpdate(
        client,
        "outbox_events",
        { id: event.id },
        { status: "pending", next_attempt_at: nextAttemptAt },
        { returning: true }
      );
    }
    summary.rescheduled = claimed.length;
    return summary;
  }

  const eventLegs = new Map();
  for (const event of claimed) {
    const resolved = await resolveEventLegs({ client, event });
    if (resolved.skip) {
      await skipEvent({ client, event, reason: resolved.skip, now });
      summary.skipped += 1;
      continue;
    }
    eventLegs.set(event.id, resolved.legs);
  }

  const allLegs = [...eventLegs.values()].flat();
  if (allLegs.length > 0) {
    // A thrown error anywhere in this block (a transient PostgREST outage,
    // an adapter call rejecting outright rather than reporting a per-send
    // outcome) must never crash the whole drain route -- it is caught here
    // and every leg that never reached a terminal state (leg.terminal still
    // undefined/false) falls through to finalizeEvent's normal
    // retry/backoff path below, exactly as if each individual send had
    // reported "retryable". Legs that DID complete before the failure keep
    // whatever terminal state they already reached (finalizeEvent only
    // retries an event whose legs are not ALL terminal).
    try {
      await attachDeliveryRows({ client, legs: allLegs, config: { maxAttempts } });

      const pending = allLegs.filter((leg) => leg.needsAttempt);
      const inApp = pending.filter((leg) => leg.channel === "in_app" || leg.channel === "push");
      const immediateEmail = pending.filter((leg) => leg.channel === "email" && !leg.binding.digest);
      const digestEmail = pending.filter((leg) => leg.channel === "email" && leg.binding.digest);

      for (const leg of inApp) {
        await handOffToNotificationJobs({ client, leg, nowIso: toIso(now) });
      }
      await runImmediateEmailSends({ client, legs: immediateEmail, adapters, appUrl, now, maxAttempts });
      await runDigestSends({ client, legs: digestEmail, adapters, appUrl, now, maxAttempts });
    } catch (error) {
      reportError(error, {
        dsn: config.dsn,
        fetchImpl: config.observabilityFetch,
        route: "report-distribution/drain",
        status: "retry",
        requestId: null,
        userId: null
      });
    }
  }

  for (const [eventId, legs] of eventLegs.entries()) {
    const event = claimed.find((candidate) => candidate.id === eventId);
    const outcome = await finalizeEvent({ client, event, legs, now, maxAttempts, config });
    if (outcome === "processed") summary.processed += 1;
    else if (outcome === "retried") summary.retried += 1;
    else summary.failed += 1;
  }

  return summary;
}
