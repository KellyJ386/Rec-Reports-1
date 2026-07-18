import { pgSelect, pgInsert } from "../supabase-rest.mjs";
import { requireAuthPermission } from "./guard.mjs";

const READ = "communications.read";
const PUBLISH = "communications.publish";

const MESSAGE_COLUMNS =
  "id,facility_id,channel_id,author_employee_id,message_type,subject,body_text,priority,is_required_ack,ack_due_at,published_at,created_at,updated_at";
const MESSAGE_AUDIENCES_COLUMNS = "id,facility_id,message_id,audience_type,audience_ref_id,rule_jsonb,created_at";
const MESSAGE_ACKNOWLEDGEMENTS_COLUMNS =
  "id,facility_id,message_id,employee_id,ack_state,acknowledged_at,ack_method,signature_path,created_at,updated_at";

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

        const row = {
          facility_id: message.facility_id,
          message_id: params.id,
          employee_id: auth.claims.sub,
          ack_state: "acknowledged",
          acknowledged_at: new Date().toISOString()
        };
        const rows = await pgInsert(auth.client, "message_acknowledgements", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  return router;
}
