// Wave 3 Slice 3E routes: CM-13 emergency mode and CM-16's polled inbox
// summary (CM-10's ladder is a sweep, src/lib/comms-escalation-sweep.mjs, and
// CM-12's shift targeting lives in the existing audience routes). Same
// injected-primitives shape as every other route module:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Emergency mode, end to end (every step re-checked server-side AND by the
// 0064 database guards, so a raw PostgREST caller meets the same rules):
//   1. A publisher composes a DRAFT with priority 'emergency' on an
//      emergency-enabled channel and its audiences (the ordinary compose
//      routes; the ordinary publish route refuses emergency messages).
//   2. POST .../emergency-launch (communications.publish) records the request
//      in emergency_alert_launches (status pending_approval), attributed to
//      the caller's own employee. From that moment the message and its
//      audience are frozen for client sessions, and the database pins a hash
//      of its subject, body, channel and audience to the request.
//   3. POST .../emergency-approve (communications.publish) is the approval
//      step, and it is ONE call to public.approve_emergency_launch(): a
//      SECURITY DEFINER function that re-checks the caller's permission,
//      approves the launch (a different PERSON than the requester by default,
//      the tenant setting communications.emergencyRequiresSecondApprover),
//      checks the content hash, derives the recipients from the message's own
//      audience rows, publishes the message, enqueues the single
//      message.emergency job (every channel, quiet hours bypassed) and stamps
//      the launch `launched` with the recipient count -- in one transaction.
//      This route writes no job, no message and no launch row itself: a client
//      session cannot (0064's notification_jobs, launch and message guards
//      refuse it), so the four-eyes rule cannot be walked around with a raw
//      PostgREST call either. The approval queue (GET .../emergency-launches)
//      is the same database's view: it carries the message body and the number
//      of people the audience resolves to right now.
//   4. Employees answer with POST /messages/:id/emergency-response -- their
//      OWN employee row only, never an id from the body.
//   5. Publishers read the roll-up (per message, and facility-wide).
import { pgSelect, pgInsert, pgUpdate, pgRpc, PostgrestError } from "../supabase-rest.mjs";
import { authCanAccessFacility, makeGuards } from "./guard.mjs";
import {
  EMERGENCY_RESPONSES,
  INBOX_WINDOW_DAYS,
  isEmergencyResponse,
  resolveMessageAudience,
  summarizeEmergencyResponses,
  summarizeInbox
} from "../communications.mjs";
import { loadAudienceResolutionContext, resolutionContextFrom } from "../communications-audience.mjs";

const READ = "communications.read";
const PUBLISH = "communications.publish";

const MESSAGE_COLUMNS =
  "id,facility_id,channel_id,author_employee_id,message_type,subject,body_text,priority,is_required_ack,ack_due_at,published_at,deleted_at,created_at,updated_at";
const AUDIENCE_COLUMNS = "id,facility_id,message_id,audience_type,audience_ref_id,rule_jsonb";
const LAUNCH_COLUMNS =
  "id,facility_id,message_id,requested_by_employee_id,requested_at,approved_by_employee_id,approved_at,status,launched_at,recipient_count,created_at,updated_at";
const RESPONSE_COLUMNS = "id,facility_id,message_id,employee_id,response,note,responded_at";
const ROLLUP_WINDOW_DAYS = 30;
const ROLLUP_MESSAGE_LIMIT = 50;
const INBOX_MESSAGE_LIMIT = 200;
const LIST_NAME_LIMIT = 200;

export function registerCommunicationsEscalationRoutes(router, { authenticate, sendJson, readBody }) {
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

  async function loadFacilityMessage(client, facilityId, messageId) {
    const message = await loadMessage(client, messageId);
    if (!message || message.facility_id !== facilityId || message.deleted_at) return null;
    return message;
  }

  // The caller's OWN employees.id in a facility, from their auth user id --
  // never taken from a request body.
  async function loadCallerEmployeeId(client, facilityId, userId) {
    const rows = await pgSelect(client, "employees", {
      filters: { facility_id: facilityId, user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? [])[0]?.id ?? null;
  }

  async function loadLaunch(client, messageId) {
    const rows = await pgSelect(client, "emergency_alert_launches", {
      filters: { message_id: messageId },
      select: LAUNCH_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolves one published message's audience (shift windows evaluated at its
  // own published_at, like the publish snapshot).
  async function resolveAudience(client, message, { now = null } = {}) {
    const at = now ?? (message.published_at ? new Date(message.published_at) : new Date());
    const audiences =
      (await pgSelect(client, "message_audiences", {
        filters: { message_id: message.id },
        select: AUDIENCE_COLUMNS
      })) ?? [];
    const loaded = await loadAudienceResolutionContext(client, message.facility_id, audiences, { now: at });
    const recipients = resolveMessageAudience({ audiences: loaded.resolvableAudiences }, resolutionContextFrom(loaded, at));
    return { recipients, unresolvedAudiences: loaded.unresolvedAudiences };
  }

  // --- Launch request (CM-13) -----------------------------------------------
  router.register(
    "POST",
    "/facilities/:facilityId/messages/:id/emergency-launch",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;

        const message = await loadFacilityMessage(auth.client, params.facilityId, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (message.published_at) return sendJson(response, 409, { error: "message already published" });
        if (message.priority !== "emergency") {
          return sendJson(response, 409, { error: "only a message with priority 'emergency' can be launched as an emergency" });
        }

        const channels = await pgSelect(auth.client, "communication_channels", {
          filters: { id: message.channel_id, facility_id: params.facilityId },
          select: "id,emergency_enabled",
          limit: 1
        });
        if ((channels ?? [])[0]?.emergency_enabled !== true) {
          return sendJson(response, 409, { error: "the message channel is not emergency-enabled" });
        }

        const existing = await loadLaunch(auth.client, message.id);
        if (existing) {
          return sendJson(response, 409, { error: `an emergency launch already exists for this message (${existing.status})` });
        }

        const employeeId = await loadCallerEmployeeId(auth.client, params.facilityId, auth.claims.sub);
        if (!employeeId) return sendJson(response, 403, { error: "no employee record for this facility" });

        const rows = await pgInsert(
          auth.client,
          "emergency_alert_launches",
          [{ facility_id: params.facilityId, message_id: message.id, requested_by_employee_id: employeeId }],
          { returning: true }
        );
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // --- Approval + broadcast (CM-13) -----------------------------------------
  // One database call does everything (see the header). The route only
  // authenticates, checks the path, and translates the function's refusals
  // (PostgREST carries its PTnnn codes as the HTTP status) into clean
  // responses.
  router.register(
    "POST",
    "/facilities/:facilityId/messages/:id/emergency-approve",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;

        const message = await loadFacilityMessage(auth.client, params.facilityId, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });

        let result;
        try {
          result = await pgRpc(auth.client, "approve_emergency_launch", { p_message_id: message.id });
        } catch (error) {
          if (error instanceof PostgrestError && [400, 403, 404, 409].includes(error.status)) {
            return sendJson(response, error.status, {
              error: error.body?.message ?? "emergency approval rejected"
            });
          }
          throw error;
        }
        return sendJson(response, 200, {
          launchId: result?.launchId ?? null,
          status: result?.status ?? "launched",
          publishedAt: result?.publishedAt ?? null,
          recipientCount: result?.recipientCount ?? 0,
          channels: result?.channels ?? [],
          quietHoursBypass: result?.quietHoursBypass === true,
          unresolvedAudiences: result?.unresolvedAudiences ?? 0
        });
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/messages/:id/emergency-cancel",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;
        const message = await loadFacilityMessage(auth.client, params.facilityId, params.id);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        const launch = await loadLaunch(auth.client, message.id);
        if (!launch || launch.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "no emergency launch has been requested for this message" });
        }
        if (launch.status === "launched" || launch.status === "cancelled") {
          return sendJson(response, 409, { error: `emergency launch is already ${launch.status}` });
        }
        const rows = await pgUpdate(
          auth.client,
          "emergency_alert_launches",
          { id: launch.id, status: { in: ["pending_approval", "approved"] } },
          { status: "cancelled" },
          { returning: true }
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          return sendJson(response, 409, { error: "emergency launch can no longer be cancelled" });
        }
        return sendJson(response, 200, rows[0]);
      })
  );

  // Approval queue for the compose panel. Served by the database (the
  // emergency_launch_queue function re-checks communications.publish) so the
  // approver sees the message BODY and the number of people its audience
  // resolves to right now -- from the same resolver the approval itself uses --
  // plus whether the content changed since the request (in which case the
  // approval will be refused).
  router.register(
    "GET",
    "/facilities/:facilityId/emergency-launches",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;
        const status = queryParams(request).get("status");
        if (status !== null && !["pending_approval", "approved", "launched", "cancelled"].includes(status)) {
          return sendJson(response, 400, { error: "status must be pending_approval, approved, launched or cancelled" });
        }
        const rows = await pgRpc(auth.client, "emergency_launch_queue", {
          p_facility_id: params.facilityId,
          p_status: status
        });
        return sendJson(response, 200, Array.isArray(rows) ? rows : []);
      })
  );

  // --- Employee response (CM-13) ----------------------------------------------
  // Records the CALLER's own "I am safe" / "need help". The employee id comes
  // only from the caller's own employees row; a body-supplied employeeId is
  // ignored outright (and the database guard + RLS bind the row to the caller
  // independently).
  router.register(
    "POST",
    "/messages/:id/emergency-response",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { response: answer, note } = body.payload;
        const errors = [];
        if (!isEmergencyResponse(answer)) errors.push(`response must be one of: ${EMERGENCY_RESPONSES.join(", ")}`);
        if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 500)) {
          errors.push("note must be a string of at most 500 characters");
        }
        if (errors.length > 0) return sendJson(response, 400, { errors });

        const message = await loadMessage(auth.client, params.id);
        if (!message || message.deleted_at) return sendJson(response, 404, { error: "message not found" });
        if (!requireRead(auth, message.facility_id, response)) return;
        if (message.priority !== "emergency" || !message.published_at) {
          return sendJson(response, 409, { error: "message is not a published emergency alert" });
        }

        const employeeId = await loadCallerEmployeeId(auth.client, message.facility_id, auth.claims.sub);
        if (!employeeId) return sendJson(response, 403, { error: "no employee record for this facility" });

        const rows = await pgInsert(
          auth.client,
          "emergency_alert_responses",
          [
            {
              facility_id: message.facility_id,
              message_id: message.id,
              employee_id: employeeId,
              response: answer,
              note: typeof note === "string" && note.trim().length > 0 ? note.trim() : null
            }
          ],
          { onConflict: "message_id,employee_id", merge: true, returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Roll-ups (CM-13) ---------------------------------------------------------
  async function namesFor(client, facilityId, employeeIds) {
    const ids = [...new Set(employeeIds)].slice(0, LIST_NAME_LIMIT);
    if (ids.length === 0) return new Map();
    const rows =
      (await pgSelect(client, "employees", {
        filters: { facility_id: facilityId, id: { in: ids } },
        select: "id,first_name,last_name"
      })) ?? [];
    return new Map(rows.map((row) => [row.id, `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()]));
  }

  router.register(
    "GET",
    "/facilities/:facilityId/messages/:messageId/emergency-rollup",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;
        const paging = parseListLimitOffset(queryParams(request), { defaultLimit: LIST_NAME_LIMIT, maxLimit: LIST_NAME_LIMIT });
        if (!paging.ok) return sendJson(response, 400, { error: paging.error });
        const message = await loadFacilityMessage(auth.client, params.facilityId, params.messageId);
        if (!message) return sendJson(response, 404, { error: "message not found" });
        if (message.priority !== "emergency" || !message.published_at) {
          return sendJson(response, 409, { error: "message is not a published emergency alert" });
        }

        const { recipients } = await resolveAudience(auth.client, message);
        const responses =
          (await pgSelect(auth.client, "emergency_alert_responses", {
            filters: { message_id: message.id },
            select: RESPONSE_COLUMNS
          })) ?? [];
        const summary = summarizeEmergencyResponses(recipients, responses);
        const names = await namesFor(auth.client, params.facilityId, [
          ...summary.needHelpEmployeeIds.slice(0, paging.limit),
          ...summary.noResponseEmployeeIds.slice(0, paging.limit)
        ]);
        const byEmployee = new Map(responses.map((row) => [row.employee_id, row]));
        return sendJson(response, 200, {
          messageId: message.id,
          subject: message.subject,
          publishedAt: message.published_at,
          total: summary.total,
          safe: summary.safe,
          needHelp: summary.needHelp,
          noResponse: summary.noResponse,
          outsideAudience: summary.outsideAudience,
          needHelpEmployees: summary.needHelpEmployeeIds.slice(0, paging.limit).map((id) => ({
            employeeId: id,
            name: names.get(id) ?? null,
            note: byEmployee.get(id)?.note ?? null,
            respondedAt: byEmployee.get(id)?.responded_at ?? null
          })),
          noResponseEmployees: summary.noResponseEmployeeIds.slice(0, paging.limit).map((id) => ({
            employeeId: id,
            name: names.get(id) ?? null
          }))
        });
      })
  );

  // Facility-wide roll-up: every emergency alert published in the last 30
  // days (?days=1..90) with its safe / need-help / no-response counts, newest first.
  router.register(
    "GET",
    "/facilities/:facilityId/emergency-alerts",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;
        let days = ROLLUP_WINDOW_DAYS;
        const daysParam = queryParams(request).get("days");
        if (daysParam !== null) {
          days = Number(daysParam);
          if (!Number.isInteger(days) || days < 1 || days > 90) {
            return sendJson(response, 400, { error: "days must be an integer from 1 to 90" });
          }
        }
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const messages =
          (await pgSelect(auth.client, "messages", {
            filters: { facility_id: params.facilityId, priority: "emergency" },
            select: MESSAGE_COLUMNS,
            order: "published_at.desc",
            limit: ROLLUP_MESSAGE_LIMIT,
            extra: { published_at: `gte.${cutoff}`, deleted_at: "is.null" }
          })) ?? [];
        if (messages.length === 0) return sendJson(response, 200, []);

        const ids = messages.map((message) => message.id);
        const audiences =
          (await pgSelect(auth.client, "message_audiences", {
            filters: { message_id: { in: ids } },
            select: AUDIENCE_COLUMNS
          })) ?? [];
        const loaded = await loadAudienceResolutionContext(auth.client, params.facilityId, audiences, {
          anchors: messages.map((message) => new Date(message.published_at))
        });
        const audiencesByMessage = new Map();
        for (const audience of loaded.resolvableAudiences) {
          const list = audiencesByMessage.get(audience.message_id) ?? [];
          list.push(audience);
          audiencesByMessage.set(audience.message_id, list);
        }
        const responses =
          (await pgSelect(auth.client, "emergency_alert_responses", {
            filters: { message_id: { in: ids } },
            select: RESPONSE_COLUMNS
          })) ?? [];
        const responsesByMessage = new Map();
        for (const row of responses) {
          const list = responsesByMessage.get(row.message_id) ?? [];
          list.push(row);
          responsesByMessage.set(row.message_id, list);
        }

        return sendJson(
          response,
          200,
          messages.map((message) => {
            const at = new Date(message.published_at);
            const recipients = resolveMessageAudience(
              { audiences: audiencesByMessage.get(message.id) ?? [] },
              resolutionContextFrom(loaded, at)
            );
            const summary = summarizeEmergencyResponses(recipients, responsesByMessage.get(message.id) ?? []);
            return {
              messageId: message.id,
              subject: message.subject,
              publishedAt: message.published_at,
              total: summary.total,
              safe: summary.safe,
              needHelp: summary.needHelp,
              noResponse: summary.noResponse
            };
          })
        );
      })
  );

  // --- CM-16: polled inbox summary ---------------------------------------------
  // The zero-dependency default for "live" unread/ack counters: one cheap
  // GET the home dashboard polls every 30 s (backing off while the tab is
  // hidden) -- no websocket, no SSE, no new runtime dependency.
  router.register(
    "GET",
    "/me/inbox-summary",
    (request, response, { env }) =>
      withAuth(request, response, env, async (auth) => {
        const facilityId = queryParams(request).get("facilityId");
        if (!facilityId) return sendJson(response, 400, { error: "facilityId query parameter is required" });
        if (!authCanAccessFacility(auth, facilityId)) {
          return sendJson(response, 403, { error: "not a member of this facility" });
        }
        if (!requireRead(auth, facilityId, response)) return;

        const now = new Date();
        const cutoff = new Date(now.getTime() - INBOX_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const messages =
          (await pgSelect(auth.client, "messages", {
            filters: { facility_id: facilityId },
            select: "id,subject,body_text,priority,is_required_ack,ack_due_at,published_at",
            order: "published_at.desc",
            limit: INBOX_MESSAGE_LIMIT,
            extra: { published_at: `gte.${cutoff}`, deleted_at: "is.null" }
          })) ?? [];

        const employeeId = await loadCallerEmployeeId(auth.client, facilityId, auth.claims.sub);
        let readMessageIds = [];
        let ackedMessageIds = [];
        let emergencyResponses = [];
        if (employeeId && messages.length > 0) {
          const ids = messages.map((message) => message.id);
          const emergencyIds = messages.filter((message) => message.priority === "emergency").map((message) => message.id);
          const [receipts, acks, responses] = await Promise.all([
            pgSelect(auth.client, "message_receipts", {
              filters: { facility_id: facilityId, employee_id: employeeId, message_id: { in: ids } },
              select: "message_id,read_at"
            }),
            pgSelect(auth.client, "message_acknowledgements", {
              filters: { facility_id: facilityId, employee_id: employeeId, message_id: { in: ids } },
              select: "message_id,acknowledged_at,ack_state"
            }),
            emergencyIds.length > 0
              ? pgSelect(auth.client, "emergency_alert_responses", {
                  filters: { facility_id: facilityId, employee_id: employeeId, message_id: { in: emergencyIds } },
                  select: "message_id,response"
                })
              : Promise.resolve([])
          ]);
          readMessageIds = (receipts ?? []).filter((row) => row.read_at).map((row) => row.message_id);
          ackedMessageIds = (acks ?? [])
            .filter((row) => row.acknowledged_at || row.ack_state === "acknowledged" || row.ack_state === "waived")
            .map((row) => row.message_id);
          emergencyResponses = responses ?? [];
        }

        // A caller with no employee record in this facility has no personal
        // inbox: counts are zero rather than "everything is unread".
        const summary = summarizeInbox(
          employeeId
            ? { messages, readMessageIds, ackedMessageIds, emergencyResponses }
            : { messages: messages.filter((message) => message.priority === "emergency") },
          now
        );
        if (!employeeId) {
          summary.unreadCount = 0;
          summary.pendingAcks = { count: 0, overdueCount: 0, nextDueAt: null };
        }
        return sendJson(response, 200, { facilityId, generatedAt: now.toISOString(), ...summary });
      })
  );

  return router;
}
