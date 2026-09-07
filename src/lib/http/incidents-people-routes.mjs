import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { reportError } from "../observability.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import { buildIncidentAuditEvent } from "../incidents.mjs";

// P-6 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2B) / IN-12
// (plans/INCIDENTS_PLAN.md). People-involved CRUD (soft-delete, no hard
// delete -- matches incident_people's own deleted_at column) and versioned
// witness statements (0050_incident_people_statements.sql's
// incident_witness_statements: append-only, one row per submitted version,
// locked forever once signed). Split out of incidents-routes.mjs into its
// own module (rather than growing that already-1000-line file further)
// because this surface has its own guard shape (facilityId AND incidentId
// both live in the URL, unlike incidents-routes.mjs's bare /incidents/:id
// sub-resource routes) and its own small set of helpers -- copied, not
// imported, from incidents-routes.mjs (loadIncident/writeAuditEvent/
// requireAnyPerm) since none of them are exported there; keeping this
// module self-contained matches every other route file's own-helpers
// convention in this codebase.
//
// Reads: incidents.read. Writes (add/update/soft-delete a person; add/sign a
// statement): incidents.manage OR incidents.review, matching this module's
// established "review is a distinct, narrower-than-manage governance
// surface that can still act on case content" design (incident_amendments,
// 0032; incident_reports transitions, 0043(d)) and the RLS policies this
// migration adds to match (0050).
//
// Every route validates that the incident named in the URL actually belongs
// to the facility named in the URL, and (for /people/:personId routes) that
// the person belongs to both -- a mismatch on either is answered as a plain
// 404 "not found" rather than 403, so a caller can never distinguish "wrong
// facility" from "no such row" by probing another facility's ids (matching
// attachments-routes.mjs's notFoundOnDeny posture for the same reason).
export function registerIncidentPeopleRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requireRead: requireReadFactory, parseJsonBody } = guards;
  const requireRead = requireReadFactory("incidents.read");

  const WRITE_CODES = ["incidents.manage", "incidents.review"];

  // Allowed if the actor holds ANY of `codes` at facilityId -- copied from
  // incidents-routes.mjs's own requireAnyPerm (not exported there).
  function requireAnyPerm(auth, facilityId, codes, response) {
    const allowed = codes.some((code) => requireAuthPermission(auth, facilityId, code).allowed);
    if (!allowed) {
      sendJson(response, 403, { error: `missing permission: one of ${codes.join(", ")}` });
      return false;
    }
    return true;
  }

  function requireWrite(auth, facilityId, response) {
    return requireAnyPerm(auth, facilityId, WRITE_CODES, response);
  }

  // Inserts one incident_audit_events row -- copied verbatim (behavior, not
  // just shape) from incidents-routes.mjs's own writeAuditEvent: same
  // console.error fallback (so a failure is visible locally even without
  // OBSERVABILITY_DSN configured), same reportError call, same 500 response
  // on failure, same "caller must check the return value and bail out"
  // contract.
  async function writeAuditEvent(auth, response, env, event) {
    try {
      await pgInsert(auth.client, "incident_audit_events", [event], { returning: false });
      return true;
    } catch (error) {
      console.error(
        `incidents.audit_write/${event.event_type} failed for incident ${event.incident_id}:`,
        error
      );
      reportError(error, {
        dsn: env?.OBSERVABILITY_DSN,
        route: `incidents.audit_write/${event.event_type}`,
        status: 500,
        requestId: event.incident_id,
        userId: auth.claims?.sub ?? null
      });
      sendJson(response, 500, { error: "audit write failed", entity_id: event.incident_id });
      return false;
    }
  }

  const PERSON_ROLES = ["injured_party", "witness", "staff", "contractor", "visitor"];
  const PEOPLE_COLUMNS =
    "id,facility_id,incident_id,person_role,full_name,contact_json,injury_json,statement_text," +
    "statement_submitted_at,created_at,updated_at,deleted_at";
  const STATEMENT_COLUMNS =
    "id,facility_id,incident_id,person_id,version_no,statement_text,submitted_by,submitted_at,signed_at,deleted_at";

  async function loadIncident(client, incidentId) {
    const rows = await pgSelect(client, "incident_reports", {
      filters: { id: incidentId },
      select: "id,facility_id",
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Loads a person row regardless of deleted_at -- callers decide whether a
  // soft-deleted person is acceptable for the action at hand (a statement
  // read still works; adding a NEW statement for an already-removed person
  // does not, see the POST .../statements route below).
  async function loadPerson(client, personId) {
    const rows = await pgSelect(client, "incident_people", {
      filters: { id: personId },
      select: PEOPLE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  async function loadStatement(client, statementId) {
    const rows = await pgSelect(client, "incident_witness_statements", {
      filters: { id: statementId },
      select: STATEMENT_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolves and validates the incident named in the URL. Returns null (and
  // has already responded 404) when it does not exist or does not belong to
  // the facility in the URL.
  async function resolveIncident(auth, params, response) {
    const incident = await loadIncident(auth.client, params.incidentId);
    if (!incident || incident.facility_id !== params.facilityId) {
      sendJson(response, 404, { error: "incident not found" });
      return null;
    }
    return incident;
  }

  // Resolves and validates the person named in the URL against the already-
  // resolved incident. Returns null (and has already responded 404) when it
  // does not exist or does not belong to that incident/facility.
  async function resolvePerson(auth, params, incident, response) {
    const person = await loadPerson(auth.client, params.personId);
    if (!person || person.facility_id !== params.facilityId || person.incident_id !== incident.id) {
      sendJson(response, 404, { error: "person not found" });
      return null;
    }
    return person;
  }

  // --- People --------------------------------------------------------------
  // Lists the people involved in an incident (injured parties, witnesses,
  // staff, contractors, visitors), excluding soft-deleted rows. Oldest
  // first, matching every other incident sub-resource list's created_at.asc.
  router.register(
    "GET",
    "/facilities/:facilityId/incidents/:incidentId/people",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const rows = await pgSelect(auth.client, "incident_people", {
          filters: { incident_id: incident.id, facility_id: params.facilityId },
          extra: { deleted_at: "is.null" },
          select: PEOPLE_COLUMNS,
          order: "created_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Adds a person to an incident. Shape is validated (personRole against
  // the incident_people check constraint, fullName required) before any
  // fetch, matching POST /incidents' own "shape-then-guard" order.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/people",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { personRole, fullName, contact, injury } = body.payload;
        const shape = [];
        if (!personRole || !PERSON_ROLES.includes(personRole)) {
          shape.push(`personRole must be one of: ${PERSON_ROLES.join(", ")}`);
        }
        if (!fullName || !String(fullName).trim()) shape.push("fullName is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;

        const row = {
          facility_id: params.facilityId,
          incident_id: incident.id,
          person_role: personRole,
          full_name: String(fullName).trim(),
          contact_json: contact && typeof contact === "object" ? contact : {},
          injury_json: injury && typeof injury === "object" ? injury : {}
        };
        const rows = await pgInsert(auth.client, "incident_people", [row], { returning: true });
        const created = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.person_added",
            payload: { actor: auth.claims.sub, personId: created?.id ?? null, personRole }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 201, created);
      })
  );

  // Updates a person's role/name/contact/injury details. Only the fields
  // present in the body are changed; personRole (when present) is validated
  // against the same check-constraint vocabulary as create.
  router.register(
    "PATCH",
    "/facilities/:facilityId/incidents/:incidentId/people/:personId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { personRole, fullName, contact, injury } = body.payload;
        if (personRole !== undefined && !PERSON_ROLES.includes(personRole)) {
          return sendJson(response, 400, { error: `personRole must be one of: ${PERSON_ROLES.join(", ")}` });
        }
        if (fullName !== undefined && !String(fullName).trim()) {
          return sendJson(response, 400, { error: "fullName cannot be blank" });
        }

        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const person = await resolvePerson(auth, params, incident, response);
        if (!person) return;
        if (person.deleted_at) return sendJson(response, 409, { error: "person has been removed" });

        const patch = { updated_at: new Date().toISOString() };
        if (personRole !== undefined) patch.person_role = personRole;
        if (fullName !== undefined) patch.full_name = String(fullName).trim();
        if (contact !== undefined) patch.contact_json = contact && typeof contact === "object" ? contact : {};
        if (injury !== undefined) patch.injury_json = injury && typeof injury === "object" ? injury : {};

        const rows = await pgUpdate(
          auth.client,
          "incident_people",
          { id: person.id },
          patch,
          { returning: true }
        );
        const updated = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.person_updated",
            payload: { actor: auth.claims.sub, personId: person.id }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, updated);
      })
  );

  // Soft-deletes a person (deleted_at, never a SQL DELETE -- incident_people
  // has no DELETE RLS policy either, matching every other incident_* table's
  // append-only-row posture). Idempotent-by-rejection: an already-removed
  // person 409s rather than silently succeeding again, so a caller can tell
  // a stale double-click apart from a real removal.
  router.register(
    "DELETE",
    "/facilities/:facilityId/incidents/:incidentId/people/:personId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const person = await resolvePerson(auth, params, incident, response);
        if (!person) return;
        if (person.deleted_at) return sendJson(response, 409, { error: "person already removed" });

        const rows = await pgUpdate(
          auth.client,
          "incident_people",
          { id: person.id },
          { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { returning: true }
        );
        const updated = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.person_removed",
            payload: { actor: auth.claims.sub, personId: person.id }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, updated);
      })
  );

  // --- Witness statements ---------------------------------------------------
  // Lists every version of a person's statement, oldest first, so the UI can
  // render the full append-only history (matching the amendment history
  // panel's "immutable, every entry retained" framing).
  router.register(
    "GET",
    "/facilities/:facilityId/incidents/:incidentId/people/:personId/statements",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const person = await resolvePerson(auth, params, incident, response);
        if (!person) return;
        const rows = await pgSelect(auth.client, "incident_witness_statements", {
          filters: { person_id: person.id },
          select: STATEMENT_COLUMNS,
          order: "version_no.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Submits a new statement version. version_no is always
  // max(existing version_no) + 1, server-computed -- never client-supplied,
  // matching incident_no's (IN-09) "server is the sole numbering authority"
  // rule. Once ANY existing version for this person carries a signed_at,
  // the whole history is locked: no further version may be added (409),
  // matching IN-12's "signed statements immutable" acceptance criterion at
  // the append boundary, not just the edit boundary.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/people/:personId/statements",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const statementText = body.payload.statementText;
        if (!statementText || !String(statementText).trim()) {
          return sendJson(response, 400, { error: "statementText is required" });
        }

        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const person = await resolvePerson(auth, params, incident, response);
        if (!person) return;
        if (person.deleted_at) return sendJson(response, 409, { error: "person has been removed" });

        const existing = await pgSelect(auth.client, "incident_witness_statements", {
          filters: { person_id: person.id },
          select: "version_no,signed_at"
        });
        const rows = existing ?? [];
        if (rows.some((row) => row.signed_at)) {
          return sendJson(response, 409, {
            error: "a signed statement exists for this person; no further versions may be added"
          });
        }
        const nextVersion = rows.reduce((max, row) => Math.max(max, row.version_no), 0) + 1;

        const inserted = await pgInsert(
          auth.client,
          "incident_witness_statements",
          [
            {
              facility_id: params.facilityId,
              incident_id: incident.id,
              person_id: person.id,
              version_no: nextVersion,
              statement_text: String(statementText).trim(),
              submitted_by: auth.claims.sub,
              submitted_at: new Date().toISOString()
            }
          ],
          { returning: true }
        );
        const created = (inserted ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.statement_added",
            payload: { actor: auth.claims.sub, personId: person.id, statementId: created?.id ?? null, versionNo: nextVersion }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 201, created);
      })
  );

  // Signs a statement version: sets signed_at, locking that row (and, per
  // the POST route above, every subsequent version for this person)
  // permanently. 409 when the targeted version is already signed -- both
  // the application check here AND the DB trigger
  // (fn_incident_witness_statement_guard, 0050) reject a second sign, so a
  // race between two concurrent sign requests still surfaces as a clean
  // 409 (via translatePostgrestError, guard.mjs's withAuth) rather than a
  // silent no-op update.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/people/:personId/statements/:statementId/sign",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const person = await resolvePerson(auth, params, incident, response);
        if (!person) return;

        const statement = await loadStatement(auth.client, params.statementId);
        if (!statement || statement.facility_id !== params.facilityId || statement.person_id !== person.id) {
          return sendJson(response, 404, { error: "statement not found" });
        }
        if (statement.signed_at) {
          return sendJson(response, 409, { error: "statement already signed" });
        }

        const rows = await pgUpdate(
          auth.client,
          "incident_witness_statements",
          { id: statement.id },
          { signed_at: new Date().toISOString() },
          { returning: true }
        );
        const updated = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.statement_signed",
            payload: { actor: auth.claims.sub, personId: person.id, statementId: statement.id, versionNo: statement.version_no }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, updated);
      })
  );

  return router;
}
