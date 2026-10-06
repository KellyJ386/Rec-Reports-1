import { pgSelect, pgInsert, pgUpdate, pgRpc, PostgrestError } from "../supabase-rest.mjs";
import { authCanAccessFacility, makeGuards } from "./guard.mjs";
import {
  resolveMessageAudience,
  shouldBypassQuietHours,
  channelsForPriority,
  summarizeAckCompliance,
  normalizeShiftWindow,
  serializeShiftWindow,
  audienceShiftWindow
} from "../communications.mjs";
import { loadAudienceResolutionContext, resolutionContextFrom } from "../communications-audience.mjs";
import { buildNotificationJob } from "../admin/notifications.mjs";

const READ = "communications.read";
const PUBLISH = "communications.publish";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const MESSAGE_COLUMNS =
  "id,facility_id,channel_id,author_employee_id,message_type,subject,body_text,priority,is_required_ack,ack_due_at,published_at,created_at,updated_at";
const MESSAGE_AUDIENCES_COLUMNS = "id,facility_id,message_id,audience_type,audience_ref_id,rule_jsonb,created_at";
const CHANNEL_COLUMNS = "id,facility_id,name,channel_type,department_id,shift_scoped,emergency_enabled,created_at,updated_at";
const NOTIFICATION_PREFERENCE_COLUMNS =
  "id,facility_id,employee_id,in_app_enabled,email_enabled,sms_enabled,push_enabled,quiet_hours_start,quiet_hours_end,created_at,updated_at";
const ACKNOWLEDGEMENT_COLUMNS =
  "id,facility_id,message_id,employee_id,ack_state,acknowledged_at,ack_method,signature_path,created_at,updated_at";
const RECEIPT_COLUMNS = "id,facility_id,message_id,employee_id,delivered_at,read_at,device_id,created_at";

// S-8: audience_ref_id is polymorphic (0006_communications.sql:32-41) --
// which table it points into depends on the sibling audience_type. Mirrors
// work-orders-routes.mjs's resolveFacilityRef(s): pre-resolving here turns a
// cross-facility or nonexistent ref into a clean 400 instead of letting the
// DB reject the insert as an uncaught PostgrestError (0047's policy/trigger
// still enforce this independently -- this is belt-and-suspenders for a
// clean client error, not the sole guard).
const AUDIENCE_REF_TABLES = {
  employee: "employees",
  department: "departments",
  shift: "schedule_shifts",
  role: "roles"
};

async function resolveAudienceRef(client, audienceType, refId, facilityId) {
  if (refId === undefined || refId === null) return { ok: true };
  const table = AUDIENCE_REF_TABLES[audienceType];
  const rows = await pgSelect(client, table, {
    filters: { id: refId },
    select: "id,facility_id",
    limit: 1
  });
  const row = (rows ?? [])[0];
  if (!row) return { ok: false, error: `audienceRefId not found for audienceType ${audienceType}: ${refId}` };
  if (row.facility_id !== facilityId) {
    return { ok: false, error: `audienceRefId does not belong to this facility for audienceType ${audienceType}: ${refId}` };
  }
  return { ok: true };
}

// Resolves every item's ref in turn, short-circuiting (and issuing no
// further fetches) on the first invalid one.
async function resolveAudienceRefs(client, facilityId, items) {
  for (const item of items) {
    const result = await resolveAudienceRef(client, item.audienceType, item.audienceRefId, facilityId);
    if (!result.ok) return result;
  }
  return { ok: true };
}

// Groups a list of rows (message_audiences/message_receipts/
// message_acknowledgements) by their message_id column, for the
// compliance-summary route's per-message aggregation over a batch-fetched set.
function groupByMessageId(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    const list = map.get(row.message_id) ?? [];
    list.push(row);
    map.set(row.message_id, list);
  }
  return map;
}

// M-5 / L-1: a required acknowledgement's due time must be a real date, and a
// message that is going out must not already be past due -- the escalation
// ladder would fire its reminder, supervisor and manager tiers on consecutive
// passes. (0064's messages trigger refuses the same thing for a client write.)
// Returns an error string, or null.
function ackDueAtError(ackDueAt, { publishing, now = new Date() } = {}) {
  if (ackDueAt === undefined || ackDueAt === null || ackDueAt === "") return null;
  const due = new Date(ackDueAt);
  if (Number.isNaN(due.getTime())) return "ackDueAt must be a valid date";
  if (publishing && due.getTime() <= now.getTime()) {
    return "ackDueAt must be in the future when a message is published";
  }
  return null;
}

// Registers the end-user Communications API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require communications.read on the row's facility; creating or publishing
// a message requires communications.publish. Acknowledgements require communications.read.
export function registerCommunicationRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams, parseListLimitOffset } = guards;
  const requireRead = guards.requireRead(READ);

  async function loadMessage(client, messageId) {
    const rows = await pgSelect(client, "messages", {
      filters: { id: messageId },
      select: MESSAGE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolves the caller's own employees.id in a facility from their auth user
  // id (auth.claims.sub). message_acknowledgements/message_receipts RLS keys
  // ownership off employees.id (via employees.user_id = auth.uid()), which is
  // NOT the same value as the auth user id itself -- inserting auth.claims.sub
  // directly as employee_id would never satisfy the self-service RLS policy.
  async function loadCallerEmployeeId(client, facilityId, userId) {
    const rows = await pgSelect(client, "employees", {
      filters: { facility_id: facilityId, user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? [])[0]?.id ?? null;
  }

  // --- Messages --------------------------------------------------------------
  // Lists messages for a facility, newest first. Optional ?status= filter.
  router.register(
    "GET",
    "/facilities/:facilityId/messages",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };
        const status = qp.get("status");
        // published_at is timestamptz -- PostgREST rejects eq./neq. against a
        // bare "null"/"not-null" scalar here, so this goes through `extra` as
        // a raw is.null / not.is.null filter instead of the eq-tagged filters
        // map (FILTER_OPERATORS intentionally has no is/not operator).
        const extra = {};
        if (status) extra.published_at = status === "published" ? "not.is.null" : "is.null";
        const rows = await pgSelect(auth.client, "messages", {
          filters,
          extra,
          select: MESSAGE_COLUMNS,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Returns a single message. Requires communications.read on the message's facility.
  router.register(
    "GET",
    "/messages/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const message = await loadMessage(auth.client, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, message.facility_id, response)) return;
        return sendJson(response, 200, message);
      })
  );

  // Creates a message. Validates minimal shape before guard, then inserts with
  // author_employee_id = auth.claims.sub.
  //
  // CM-03: the create route used to accept an arbitrary caller-supplied
  // `publishedAt` and write it straight through, so creating a message could
  // already publish it outright. The flow is now draft-then-publish: a
  // created message always starts as a draft (published_at null) unless the
  // legacy `publishNow: true` body flag is set, in which case it is
  // published immediately (server time) for backward compatibility with
  // that prior behavior. New callers should prefer POST .../messages/:id/publish.
  router.register(
    "POST",
    "/facilities/:facilityId/messages",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { channelId, subject, bodyText } = body.payload;
        const shape = [];
        if (!channelId) shape.push("channelId is required");
        if (!subject) shape.push("subject is required");
        if (!bodyText) shape.push("bodyText is required");
        const dueError = ackDueAtError(body.payload.ackDueAt, {
          publishing: body.payload.publishNow === true && body.payload.isRequiredAck === true
        });
        if (dueError) shape.push(dueError);
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;

        // messages.author_employee_id is FK-checked (via fn_assert_same_facility
        // in the RLS WITH CHECK) against employees.id, NOT the auth user id --
        // writing auth.claims.sub straight through here would violate the
        // policy for every real caller. Resolve the caller's own employees.id
        // first, same as the acknowledge/publish routes below.
        const authorEmployeeId = await loadCallerEmployeeId(auth.client, params.facilityId, auth.claims.sub);
        if (!authorEmployeeId) {
          return sendJson(response, 404, { error: "no employee record for this facility" });
        }

        // CM-13: an emergency message is never published by the create
        // route's legacy publishNow shortcut -- only through the
        // emergency-launch approval flow.
        if (body.payload.priority === "emergency" && body.payload.publishNow === true) {
          return sendJson(response, 409, {
            error: "emergency messages must be launched through the emergency-launch approval flow"
          });
        }

        const row = {
          facility_id: params.facilityId,
          channel_id: channelId,
          author_employee_id: authorEmployeeId,
          message_type: body.payload.messageType ?? "announcement",
          subject,
          body_text: bodyText,
          priority: body.payload.priority ?? "normal",
          is_required_ack: body.payload.isRequiredAck ?? false,
          ack_due_at: body.payload.ackDueAt ?? null,
          published_at: body.payload.publishNow === true ? new Date().toISOString() : null
        };
        const rows = await pgInsert(auth.client, "messages", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Publishes a draft message (CM-03): loads its message_audiences, resolves
  // recipients against live rows, stamps published_at, and enqueues exactly
  // one notification_jobs row carrying the resolved recipient list.
  //
  // Resolution queries (bounded, run only when the corresponding audience
  // type is present on the message -- never one query per audience row):
  //   - employees   (facility-scoped: id, department_id, user_id) -- needed
  //     to resolve 'department' audiences directly, and to join memberships
  //     -> employees for 'role' audiences.
  //   - memberships (facility-scoped, role_id in <role audience ref ids>,
  //     status='active': user_id, role_id) -- only when a 'role' audience is
  //     present; joined in-process against the employees roster above (via
  //     user_id) to build resolveMessageAudience's roleAssignments context,
  //     since memberships key off the auth user id, not employees.id.
  //   - shift_assignments (facility-scoped, shift_id in <shift audience ref
  //     ids>, status in pending/approved: shift_id, employee_id) -- only
  //     when the request body supplies a `shiftWindow` AND a 'shift'
  //     audience is present. `shiftWindow` is accepted as a simple presence
  //     gate for now (its contents are not yet used to filter by date/time
  //     range) -- full "current/next shift" window computation is CM-12.
  //     'shift' audiences with no shiftWindow are reported unresolved
  //     rather than silently dropped.
  //   - 'employee' audiences need no query: audience_ref_id is the employee
  //     id directly.
  router.register(
    "POST",
    "/facilities/:facilityId/messages/:id/publish",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const message = await loadMessage(auth.client, params.id);
        if (!message || message.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "message not found" });
        }
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;
        if (message.published_at) {
          return sendJson(response, 409, { error: "message already published" });
        }
        // CM-13: an emergency message bypasses quiet hours on every channel,
        // so it never goes out through the ordinary publish flow -- only
        // through the emergency-launch + approval flow
        // (communications-escalation-routes.mjs), which 0064's messages
        // trigger also enforces at the database.
        if (message.priority === "emergency") {
          return sendJson(response, 409, {
            error: "emergency messages must be launched through the emergency-launch approval flow"
          });
        }

        const dueError = message.is_required_ack ? ackDueAtError(message.ack_due_at, { publishing: true }) : null;
        if (dueError) return sendJson(response, 400, { error: dueError });

        const audiences = (await pgSelect(auth.client, "message_audiences", {
          filters: { message_id: params.id },
          select: MESSAGE_AUDIENCES_COLUMNS
        })) ?? [];

        // CM-12: `shiftWindow` ("current" | "next" | { from, to }) is the
        // fallback window for a ref-less shift audience that carries no
        // rule.window of its own; a specific shift id needs none. A malformed
        // value is a clean 400 rather than a silently-empty audience.
        const shiftWindow = body.payload.shiftWindow ?? null;
        if (shiftWindow !== null && normalizeShiftWindow(shiftWindow) === null) {
          return sendJson(response, 400, { error: "shiftWindow must be 'current', 'next', or { from, to } (at most 31 days)" });
        }
        // L-4: the publish-body `shiftWindow` is only a fallback for a ref-less
        // shift audience that carries no window of its own. Nothing else that
        // later re-resolves this audience (the escalation sweep, the roll-ups,
        // the compliance routes) can see the request body, and they treat such
        // an audience as unresolved -- so the effective window is written into
        // the audience row BEFORE the message goes out, and the publish fails
        // (before any side effect) if it cannot be stored.
        const fallbackWindow = serializeShiftWindow(shiftWindow);
        if (fallbackWindow) {
          for (const audience of audiences) {
            const hasRef = audience.audience_ref_id !== null && audience.audience_ref_id !== undefined;
            if (audience.audience_type !== "shift" || hasRef || audienceShiftWindow(audience)) continue;
            const rule = audience.rule_jsonb && typeof audience.rule_jsonb === "object" && !Array.isArray(audience.rule_jsonb) ? audience.rule_jsonb : {};
            const nextRule = { ...rule, window: fallbackWindow };
            await pgUpdate(auth.client, "message_audiences", { id: audience.id }, { rule_jsonb: nextRule }, { returning: true });
            audience.rule_jsonb = nextRule;
          }
        }
        // NEW-1: an urgent message bypasses quiet hours, so it is never
        // published by this route's own writes. One call to
        // public.publish_urgent_message() publishes it and writes its single
        // bypassing job in one transaction, with the recipients resolved from
        // the message's audience rows, the channels from the priority mapping
        // and no caller-supplied copy -- the notification_jobs client guard
        // (0064) refuses a client-written bypass job. The audience windows were
        // written above, so the database resolves exactly what this route
        // would have.
        if (message.priority === "urgent") {
          let urgent;
          try {
            urgent = await pgRpc(auth.client, "publish_urgent_message", { p_message_id: params.id });
          } catch (error) {
            if (error instanceof PostgrestError && [400, 403, 404, 409].includes(error.status)) {
              return sendJson(response, error.status, { error: error.body?.message ?? "urgent publish rejected" });
            }
            throw error;
          }
          return sendJson(response, 200, {
            publishedAt: urgent?.publishedAt ?? null,
            recipientCount: urgent?.recipientCount ?? 0,
            unresolvedAudiences: urgent?.unresolvedAudiences ?? 0
          });
        }

        const publishNow = new Date();
        const loaded = await loadAudienceResolutionContext(auth.client, message.facility_id, audiences, {
          shiftWindow,
          now: publishNow
        });
        const { resolvableAudiences, unresolvedAudiences } = loaded;

        const recipients = resolveMessageAudience({ audiences: resolvableAudiences }, resolutionContextFrom(loaded));

        const publishedAt = publishNow.toISOString();
        await pgUpdate(
          auth.client,
          "messages",
          { id: params.id },
          { published_at: publishedAt, updated_at: publishedAt },
          { returning: true }
        );

        // Urgent messages left through publish_urgent_message() above, and
        // emergency ones were refused at the top, so what reaches this write is
        // a message for which shouldBypassQuietHours() is false: the job never
        // asks the database for a bypass (which the client guard would refuse).
        const bypassQuietHours = shouldBypassQuietHours(message);
        const route = {
          id: null,
          facility_id: message.facility_id,
          priority: message.priority,
          route_jsonb: { channels: channelsForPriority(message.priority) }
        };
        const job = buildNotificationJob("message.published", route, recipients);
        job.payload_jsonb.messageId = params.id;
        job.payload_jsonb.quietHoursBypass = bypassQuietHours;
        await pgInsert(auth.client, "notification_jobs", [job], { returning: true });

        return sendJson(response, 200, {
          publishedAt,
          recipientCount: recipients.length,
          unresolvedAudiences
        });
      })
  );

  // Acknowledges a message by inserting a message_acknowledgements row for the
  // authenticated user. Requires communications.read.
  router.register(
    "POST",
    "/messages/:id/acknowledge",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const message = await loadMessage(auth.client, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, message.facility_id, response)) return;

        const employeeId = await loadCallerEmployeeId(auth.client, message.facility_id, auth.claims.sub);
        if (!employeeId) {
          return sendJson(response, 403, { error: "no employee record for this facility" });
        }

        const row = {
          facility_id: message.facility_id,
          message_id: params.id,
          employee_id: employeeId,
          ack_state: "acknowledged",
          acknowledged_at: new Date().toISOString()
        };
        const rows = await pgInsert(auth.client, "message_acknowledgements", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // --- Ack/read state + compliance (P-1: CM-09/CM-11) -------------------------
  // A message must exist AND belong to :facilityId (404 otherwise, mirroring
  // the publish route's own facility check) before communications.read on
  // that facility is checked (403). `?employeeId=me` resolves the caller's
  // own employees.id the same way every other self-service route in this
  // file does -- a caller with no employee row in the facility is not an
  // error here (unlike acknowledge/receipt, which are writes on the
  // caller's own behalf): it simply has never acknowledged/received
  // anything, so the list is empty rather than a 403 or 500.
  async function loadFacilityMessage(client, facilityId, messageId) {
    const message = await loadMessage(client, messageId);
    if (!message || message.facility_id !== facilityId) return null;
    return message;
  }

  function resolveListEmployeeFilter(qp) {
    const value = qp.get("employeeId");
    if (value === null) return { present: false };
    return { present: true, isMe: value === "me", value };
  }

  router.register(
    "GET",
    "/facilities/:facilityId/messages/:messageId/acknowledgements",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const message = await loadFacilityMessage(auth.client, params.facilityId, params.messageId);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, params.facilityId, response)) return;

        const qp = queryParams(request);
        const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIST_LIMIT, maxLimit: MAX_LIST_LIMIT });
        if (!paging.ok) return sendJson(response, 400, { error: paging.error });

        const filters = { facility_id: params.facilityId, message_id: params.messageId };
        const employeeFilter = resolveListEmployeeFilter(qp);
        if (employeeFilter.present) {
          if (employeeFilter.isMe) {
            const employeeId = await loadCallerEmployeeId(auth.client, params.facilityId, auth.claims.sub);
            if (!employeeId) return sendJson(response, 200, []);
            filters.employee_id = employeeId;
          } else {
            filters.employee_id = employeeFilter.value;
          }
        }

        const rows = await pgSelect(auth.client, "message_acknowledgements", {
          filters,
          select: ACKNOWLEDGEMENT_COLUMNS,
          order: "created_at.desc",
          limit: paging.limit,
          offset: paging.offset
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "GET",
    "/facilities/:facilityId/messages/:messageId/receipts",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const message = await loadFacilityMessage(auth.client, params.facilityId, params.messageId);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, params.facilityId, response)) return;

        const qp = queryParams(request);
        const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIST_LIMIT, maxLimit: MAX_LIST_LIMIT });
        if (!paging.ok) return sendJson(response, 400, { error: paging.error });

        const filters = { facility_id: params.facilityId, message_id: params.messageId };
        const employeeFilter = resolveListEmployeeFilter(qp);
        if (employeeFilter.present) {
          if (employeeFilter.isMe) {
            const employeeId = await loadCallerEmployeeId(auth.client, params.facilityId, auth.claims.sub);
            if (!employeeId) return sendJson(response, 200, []);
            filters.employee_id = employeeId;
          } else {
            filters.employee_id = employeeFilter.value;
          }
        }

        const rows = await pgSelect(auth.client, "message_receipts", {
          filters,
          select: RECEIPT_COLUMNS,
          order: "created_at.desc",
          limit: paging.limit,
          offset: paging.offset
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Per-message compliance rollup (CM-11): resolves the message's own
  // audience (exactly like the publish route, via the shared
  // loadAudienceResolutionContext -- a message with a 'shift' audience and
  // no shiftWindow reports that portion unresolved, same as publish, since
  // there is no window to evaluate a snapshot-at-publish-time schedule
  // against here) and rolls its receipts/acknowledgements up against it with
  // the pure summarizeAckCompliance.
  router.register(
    "GET",
    "/facilities/:facilityId/messages/:messageId/compliance",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const message = await loadFacilityMessage(auth.client, params.facilityId, params.messageId);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, params.facilityId, response)) return;

        const audiences =
          (await pgSelect(auth.client, "message_audiences", {
            filters: { message_id: params.messageId },
            select: MESSAGE_AUDIENCES_COLUMNS
          })) ?? [];
        // CM-12: shift windows are evaluated at the message's own
        // published_at, so a re-resolution agrees with the publish snapshot.
        const publishedAt = message.published_at ? new Date(message.published_at) : new Date();
        const loaded = await loadAudienceResolutionContext(auth.client, message.facility_id, audiences, {
          now: publishedAt
        });
        const audienceEmployeeIds = resolveMessageAudience(
          { audiences: loaded.resolvableAudiences },
          resolutionContextFrom(loaded, publishedAt)
        );

        const receipts =
          (await pgSelect(auth.client, "message_receipts", {
            filters: { message_id: params.messageId },
            select: RECEIPT_COLUMNS
          })) ?? [];
        const acks =
          (await pgSelect(auth.client, "message_acknowledgements", {
            filters: { message_id: params.messageId },
            select: ACKNOWLEDGEMENT_COLUMNS
          })) ?? [];

        const summary = summarizeAckCompliance(audienceEmployeeIds, receipts, acks, new Date(), {
          isRequiredAck: !!message.is_required_ack,
          publishedAt: message.published_at
        });
        return sendJson(response, 200, summary);
      })
  );

  // Facility-wide compliance rollup (CM-11) over messages PUBLISHED in
  // [from, to] (defaults to the last 30 days) -- draft messages never carry
  // recipients or acks yet, so they are excluded by the published_at filter
  // itself rather than a separate is_required_ack-only check. Batches the
  // audience-resolution and receipt/ack queries across every required-ack
  // message in range (via loadAudienceResolutionContext + groupByMessageId)
  // instead of one round-trip per message.
  router.register(
    "GET",
    "/facilities/:facilityId/communications/compliance-summary",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;

        const qp = queryParams(request);
        const fromParam = qp.get("from");
        const toParam = qp.get("to");
        if (fromParam !== null && Number.isNaN(new Date(fromParam).getTime())) {
          return sendJson(response, 400, { error: "from must be a valid ISO date" });
        }
        if (toParam !== null && Number.isNaN(new Date(toParam).getTime())) {
          return sendJson(response, 400, { error: "to must be a valid ISO date" });
        }
        const to = toParam ? new Date(toParam) : new Date();
        const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

        const messages =
          (await pgSelect(auth.client, "messages", {
            filters: {
              facility_id: params.facilityId,
              published_at: { gte: from.toISOString(), lte: to.toISOString() }
            },
            select: MESSAGE_COLUMNS
          })) ?? [];

        const requiredMessages = messages.filter((message) => message.is_required_ack);
        if (requiredMessages.length === 0) {
          return sendJson(response, 200, {
            messages: messages.length,
            requiredAck: 0,
            acknowledged: 0,
            pending: 0,
            overdue: 0
          });
        }

        const requiredMessageIds = requiredMessages.map((message) => message.id);
        const audiences =
          (await pgSelect(auth.client, "message_audiences", {
            filters: { message_id: { in: requiredMessageIds } },
            select: MESSAGE_AUDIENCES_COLUMNS
          })) ?? [];
        const loaded = await loadAudienceResolutionContext(auth.client, params.facilityId, audiences, {
          anchors: requiredMessages.map((message) => new Date(message.published_at))
        });
        const audiencesByMessageId = groupByMessageId(loaded.resolvableAudiences);

        const receipts =
          (await pgSelect(auth.client, "message_receipts", {
            filters: { message_id: { in: requiredMessageIds } },
            select: RECEIPT_COLUMNS
          })) ?? [];
        const acks =
          (await pgSelect(auth.client, "message_acknowledgements", {
            filters: { message_id: { in: requiredMessageIds } },
            select: ACKNOWLEDGEMENT_COLUMNS
          })) ?? [];
        const receiptsByMessageId = groupByMessageId(receipts);
        const acksByMessageId = groupByMessageId(acks);

        const now = new Date();
        const rollup = { acknowledged: 0, pending: 0, overdue: 0 };
        for (const message of requiredMessages) {
          const audienceEmployeeIds = resolveMessageAudience(
            { audiences: audiencesByMessageId.get(message.id) ?? [] },
            resolutionContextFrom(loaded, new Date(message.published_at))
          );
          const summary = summarizeAckCompliance(
            audienceEmployeeIds,
            receiptsByMessageId.get(message.id) ?? [],
            acksByMessageId.get(message.id) ?? [],
            now,
            { isRequiredAck: true, publishedAt: message.published_at }
          );
          rollup.acknowledged += summary.acknowledged;
          rollup.pending += summary.pending;
          rollup.overdue += summary.overdue;
        }

        return sendJson(response, 200, {
          messages: messages.length,
          requiredAck: requiredMessages.length,
          acknowledged: rollup.acknowledged,
          pending: rollup.pending,
          overdue: rollup.overdue
        });
      })
  );

  // --- Message audiences (CM-02) -----------------------------------------------
  // Lists audiences for a message. Requires communications.read on the message's facility.
  router.register(
    "GET",
    "/messages/:id/audiences",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const message = await loadMessage(auth.client, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, message.facility_id, response)) return;
        const rows = await pgSelect(auth.client, "message_audiences", {
          filters: { message_id: params.id },
          select: MESSAGE_AUDIENCES_COLUMNS,
          order: "created_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Adds audiences to a message. Bulk array of {audienceType, audienceRefId}.
  // Requires communications.publish on the message's facility. Inserted rows
  // carry facility_id from the parent message.
  router.register(
    "POST",
    "/messages/:id/audiences",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const message = await loadMessage(auth.client, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requirePerm(auth, message.facility_id, PUBLISH, response)) return;

        // Validate bulk array
        if (!Array.isArray(body.payload)) {
          return sendJson(response, 400, { error: "body must be an array" });
        }

        const ALLOWED_TYPES = ["role", "department", "shift", "employee"];
        const errors = [];
        for (const item of body.payload) {
          if (!ALLOWED_TYPES.includes(item.audienceType)) {
            errors.push(`invalid audienceType: ${item.audienceType}`);
            break; // Early exit on first invalid type
          }
          // M3: audience_ref_id is genuinely optional for department/shift/
          // role (0047 -- it degrades to zero recipients, which is a valid,
          // if inert, row), but NOT for employee: resolveMessageAudience's
          // employee branch has no other way to resolve a target, so a null
          // ref there is never inert, only wrong. 0048's DB-layer policy and
          // trigger reject this independently; this is the clean-400
          // belt-and-suspenders layer, same rationale as resolveAudienceRef
          // above.
          if (item.audienceType === "employee" && (item.audienceRefId === undefined || item.audienceRefId === null)) {
            errors.push("audienceRefId is required when audienceType is employee");
          }
        }
        if (errors.length > 0) return sendJson(response, 400, { errors });

        // CM-12: a shift audience may carry a window (rule.window) and an
        // optional department narrowing (rule.departmentId) instead of -- or
        // alongside -- a specific shift id. The stored rule is rebuilt from
        // the validated parts only, never the raw client object.
        const rules = [];
        const ruleErrors = [];
        const departmentRefs = [];
        for (const item of body.payload) {
          if (item.audienceType !== "shift") {
            rules.push(item.rule ?? {});
            continue;
          }
          const rule = {};
          const rawRule = item.rule && typeof item.rule === "object" && !Array.isArray(item.rule) ? item.rule : {};
          if (rawRule.window !== undefined && rawRule.window !== null) {
            const window = normalizeShiftWindow(rawRule.window);
            if (!window) {
              ruleErrors.push("rule.window must be 'current', 'next', or { from, to } (at most 31 days)");
            } else {
              rule.window =
                window.kind === "range"
                  ? { kind: "range", from: window.from.toISOString(), to: window.to.toISOString() }
                  : window.kind;
            }
          }
          if (rawRule.departmentId !== undefined && rawRule.departmentId !== null) {
            if (typeof rawRule.departmentId !== "string" || rawRule.departmentId.length === 0) {
              ruleErrors.push("rule.departmentId must be a department id");
            } else {
              rule.departmentId = rawRule.departmentId;
              departmentRefs.push({ audienceType: "department", audienceRefId: rawRule.departmentId });
            }
          }
          if ((item.audienceRefId ?? null) !== null && rule.window !== undefined) {
            ruleErrors.push("a shift audience takes either a specific shift id or a rule.window, not both");
          }
          rules.push(rule);
        }
        if (ruleErrors.length > 0) return sendJson(response, 400, { errors: ruleErrors });

        const refCheck = await resolveAudienceRefs(auth.client, message.facility_id, [...body.payload, ...departmentRefs]);
        if (!refCheck.ok) return sendJson(response, 400, { error: refCheck.error });

        const rows = body.payload.map((item, index) => ({
          facility_id: message.facility_id,
          message_id: params.id,
          audience_type: item.audienceType,
          audience_ref_id: item.audienceRefId ?? null,
          rule_jsonb: rules[index]
        }));

        const inserted = await pgInsert(auth.client, "message_audiences", rows, { returning: true });
        return sendJson(response, 201, inserted ?? []);
      })
  );

  // --- Communication channels (CM-04) ------------------------------------------
  // Lists channels for a facility. Requires communications.read.
  router.register(
    "GET",
    "/facilities/:facilityId/channels",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "communication_channels", {
          filters: { facility_id: params.facilityId },
          select: CHANNEL_COLUMNS,
          order: "name.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Creates a channel in a facility. name, type, department_id, shift_scoped,
  // emergency_enabled. Requires communications.publish. Unique (facility_id, name)
  // violation surfaces as 409.
  router.register(
    "POST",
    "/facilities/:facilityId/channels",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const errors = [];
        if (!body.payload.name || typeof body.payload.name !== "string" || body.payload.name.trim().length === 0) {
          errors.push("name is required");
        }
        if (!body.payload.type || typeof body.payload.type !== "string") {
          errors.push("type is required");
        }
        if (errors.length > 0) return sendJson(response, 400, { errors });

        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;
        // L-3: marking a channel emergency-capable is an admin decision (0064
        // refuses the flag to anyone without admin.manage at the database).
        if (body.payload.emergencyEnabled === true && !requirePerm(auth, params.facilityId, "admin.manage", response)) return;

        const row = {
          facility_id: params.facilityId,
          name: body.payload.name.trim(),
          channel_type: body.payload.type,
          department_id: body.payload.departmentId ?? null,
          shift_scoped: body.payload.shiftScoped ?? false,
          emergency_enabled: body.payload.emergencyEnabled ?? false
        };

        try {
          const rows = await pgInsert(auth.client, "communication_channels", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (error) {
          // Was `error.message.includes("unique")` -- a duck-typed check on
          // PostgREST's own English-language error text, which is fragile
          // (any message containing "unique" would false-positive as a
          // conflict, e.g. an unrelated column named "unique_id") and
          // doesn't even require the error to have come from PostgREST at
          // all. pgInsert/pgSelect/pgUpdate only ever throw PostgrestError
          // (supabase-rest.mjs), which carries the real HTTP status, so
          // check that directly instead of pattern-matching the message.
          if (error instanceof PostgrestError && error.status === 409) {
            return sendJson(response, 409, { error: "channel with this name already exists in this facility" });
          }
          throw error;
        }
      })
  );

  // --- Message receipts (CM-05) ------------------------------------------------
  // Upserts a receipt row for the caller's employee on a message. Marks
  // delivered_at and/or read_at. Requires communications.read on the message's
  // facility. Upserts on (message_id, employee_id), never from body-supplied ID.
  router.register(
    "POST",
    "/messages/:id/receipt",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });

        const message = await loadMessage(auth.client, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, message.facility_id, response)) return;

        const employeeId = await loadCallerEmployeeId(auth.client, message.facility_id, auth.claims.sub);
        if (!employeeId) {
          return sendJson(response, 403, { error: "no employee record for this facility" });
        }

        // Only include the markers the caller actually sent: this is a merge
        // upsert, so an explicit null would overwrite a previously recorded
        // timestamp (e.g. marking read must not erase delivered_at).
        const row = {
          facility_id: message.facility_id,
          message_id: params.id,
          employee_id: employeeId
        };
        if (body.payload.deliveredAt !== undefined) row.delivered_at = body.payload.deliveredAt;
        if (body.payload.readAt !== undefined) row.read_at = body.payload.readAt;

        const rows = await pgInsert(auth.client, "message_receipts", [row], {
          onConflict: "message_id,employee_id",
          merge: true,
          returning: true
        });
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Device tokens (CM-07) ----------------------------------------------------
  // Registers or refreshes the caller's OWN push device token. There is no
  // :facilityId path segment on a /me route, so facilityId is required in the
  // body purely to resolve the caller's employees.id via loadCallerEmployeeId
  // -- exactly like every other self-service write in this file, the
  // employee id itself is NEVER trusted from the body. Upserts on the
  // table's unique `token` column (0037) so re-registering the same token
  // (app relaunch, a refreshed provider token that happens to collide, a
  // duplicate register call) updates last_seen_at/facility/employee in place
  // rather than creating a second row, and un-revokes it (revoked_at ->
  // null) since sending a token again means the client is actively using it.
  router.register(
    "POST",
    "/me/device-tokens",
    (request, response, { env }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { facilityId, platform, token } = body.payload;
        const shape = [];
        if (!facilityId) shape.push("facilityId is required");
        if (!platform) shape.push("platform is required");
        if (!token) shape.push("token is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        if (!authCanAccessFacility(auth, facilityId)) {
          return sendJson(response, 403, { error: "not a member of this facility" });
        }
        const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
        if (!employeeId) {
          return sendJson(response, 403, { error: "no employee record for this facility" });
        }

        const row = {
          facility_id: facilityId,
          employee_id: employeeId,
          platform,
          token,
          last_seen_at: new Date().toISOString(),
          revoked_at: null
        };
        const rows = await pgInsert(auth.client, "employee_device_tokens", [row], {
          onConflict: "token",
          merge: true,
          returning: true
        });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Revokes one of the caller's OWN device tokens (soft: sets revoked_at,
  // never a hard delete -- the worker only ever needs "is this token
  // currently active", which `revoked_at is null` answers without losing
  // history). facilityId comes from the query string, mirroring the
  // ?facilityId= convention GET /me/training-assignments already uses for
  // /me routes. The UPDATE filters on employee_id = the caller's own
  // resolved employees.id (never the bare :id path alone), so a token owned
  // by a different employee simply matches zero rows -- 404, the same
  // outcome RLS alone would already produce.
  router.register(
    "DELETE",
    "/me/device-tokens/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const facilityId = queryParams(request).get("facilityId");
        if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
        if (!authCanAccessFacility(auth, facilityId)) {
          return sendJson(response, 403, { error: "not a member of this facility" });
        }
        const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
        if (!employeeId) {
          return sendJson(response, 403, { error: "no employee record for this facility" });
        }

        const rows = await pgUpdate(
          auth.client,
          "employee_device_tokens",
          { id: params.id, employee_id: employeeId },
          { revoked_at: new Date().toISOString() },
          { returning: true }
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          return sendJson(response, 404, { error: "device token not found" });
        }
        return sendJson(response, 200, rows[0]);
      })
  );

  // --- Notification preferences (CM-07) -------------------------------------------
  // Reads the caller's own per-employee notification preferences. When no
  // row exists yet (the employee never visited a preferences screen), a
  // shipped-default shape is synthesized -- every channel enabled, no
  // personal quiet-hours override -- rather than 404ing, matching
  // employee_notification_preferences' "missing row = defaults" semantics
  // the worker (src/lib/notifications/worker.mjs) relies on too.
  router.register(
    "GET",
    "/me/notification-preferences",
    (request, response, { env }) =>
      withAuth(request, response, env, async (auth) => {
        const facilityId = queryParams(request).get("facilityId");
        if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
        if (!authCanAccessFacility(auth, facilityId)) {
          return sendJson(response, 403, { error: "not a member of this facility" });
        }
        const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
        if (!employeeId) {
          return sendJson(response, 403, { error: "no employee record for this facility" });
        }

        const rows = await pgSelect(auth.client, "employee_notification_preferences", {
          filters: { facility_id: facilityId, employee_id: employeeId },
          select: NOTIFICATION_PREFERENCE_COLUMNS,
          limit: 1
        });
        const existing = (rows ?? [])[0];
        if (existing) return sendJson(response, 200, existing);
        return sendJson(response, 200, {
          id: null,
          facility_id: facilityId,
          employee_id: employeeId,
          in_app_enabled: true,
          email_enabled: true,
          sms_enabled: true,
          push_enabled: true,
          quiet_hours_start: null,
          quiet_hours_end: null
        });
      })
  );

  // Upserts the caller's own notification preferences (onConflict on the
  // table's (facility_id, employee_id) unique pair, 0037 -- the same
  // upsert/merge pattern the CM-05 receipt route uses). A PUT replaces the
  // whole resource, so an omitted channel flag falls back to its
  // shipped-enabled default rather than silently carrying forward whatever
  // a partial body happened to send.
  router.register(
    "PUT",
    "/me/notification-preferences",
    (request, response, { env }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const facilityId = body.payload.facilityId;
        if (!facilityId) return sendJson(response, 400, { error: "facilityId is required" });
        if (!authCanAccessFacility(auth, facilityId)) {
          return sendJson(response, 403, { error: "not a member of this facility" });
        }
        const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
        if (!employeeId) {
          return sendJson(response, 403, { error: "no employee record for this facility" });
        }

        const row = {
          facility_id: facilityId,
          employee_id: employeeId,
          in_app_enabled: body.payload.inAppEnabled ?? true,
          email_enabled: body.payload.emailEnabled ?? true,
          sms_enabled: body.payload.smsEnabled ?? true,
          push_enabled: body.payload.pushEnabled ?? true,
          quiet_hours_start: body.payload.quietHoursStart ?? null,
          quiet_hours_end: body.payload.quietHoursEnd ?? null
        };
        const rows = await pgInsert(auth.client, "employee_notification_preferences", [row], {
          onConflict: "facility_id,employee_id",
          merge: true,
          returning: true
        });
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
