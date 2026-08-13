import { pgSelect, pgInsert } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";

const READ = "communications.read";
const PUBLISH = "communications.publish";

const MESSAGE_COLUMNS =
  "id,facility_id,channel_id,author_employee_id,message_type,subject,body_text,priority,is_required_ack,ack_due_at,published_at,created_at,updated_at";
const MESSAGE_AUDIENCES_COLUMNS = "id,facility_id,message_id,audience_type,audience_ref_id,rule_jsonb,created_at";
const MESSAGE_ACKNOWLEDGEMENTS_COLUMNS =
  "id,facility_id,message_id,employee_id,ack_state,acknowledged_at,ack_method,signature_path,created_at,updated_at";
const CHANNEL_COLUMNS = "id,facility_id,name,channel_type,department_id,shift_scoped,emergency_enabled,created_at,updated_at";
const MESSAGE_RECEIPTS_COLUMNS = "id,facility_id,message_id,employee_id,delivered_at,read_at,created_at";

// Registers the end-user Communications API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require communications.read on the row's facility; creating or publishing
// a message requires communications.publish. Acknowledgements require communications.read.
export function registerCommunicationRoutes(router, { authenticate, sendJson, readBody }) {
  async function parseJsonBody(request) {
    try {
      return { ok: true, payload: JSON.parse((await readBody(request)) || "{}") };
    } catch {
      return { ok: false };
    }
  }

  async function withAuth(request, response, env, handler) {
    const auth = await authenticate(request, env);
    if (auth.error) return sendJson(response, auth.error.status, auth.error.body);
    return handler(auth);
  }

  function requireRead(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, READ);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function requirePerm(auth, facilityId, code, response) {
    const guard = requireAuthPermission(auth, facilityId, code);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function queryParams(request) {
    return new URL(request.url ?? "/", "http://localhost").searchParams;
  }

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
        if (status) filters.published_at = status === "published" ? "not-null" : "null";
        const rows = await pgSelect(auth.client, "messages", {
          filters,
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
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        if (!requirePerm(auth, params.facilityId, PUBLISH, response)) return;

        const row = {
          facility_id: params.facilityId,
          channel_id: channelId,
          author_employee_id: auth.claims.sub ?? null,
          message_type: body.payload.messageType ?? "announcement",
          subject,
          body_text: bodyText,
          priority: body.payload.priority ?? "normal",
          is_required_ack: body.payload.isRequiredAck ?? false,
          ack_due_at: body.payload.ackDueAt ?? null,
          published_at: body.payload.publishedAt ?? null
        };
        const rows = await pgInsert(auth.client, "messages", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
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
        }
        if (errors.length > 0) return sendJson(response, 400, { errors });

        const rows = body.payload.map((item) => ({
          facility_id: message.facility_id,
          message_id: params.id,
          audience_type: item.audienceType,
          audience_ref_id: item.audienceRefId ?? null,
          rule_jsonb: item.rule ?? {}
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
          if (error.status === 409 || (error.message && error.message.includes("unique"))) {
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

  return router;
}
