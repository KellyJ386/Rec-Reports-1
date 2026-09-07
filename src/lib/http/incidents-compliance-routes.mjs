import { pgSelect, pgInsert, pgRpc, pgUpdate, PostgrestError } from "../supabase-rest.mjs";
import { reportError } from "../observability.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import { assertPathInFacility, StorageValidationError } from "../storage.mjs";
import { loadModuleConfig } from "./module-config.mjs";
import {
  buildIncidentAuditEvent,
  SIGNATURE_ROLES,
  validateAttestationText,
  COMPLIANCE_CHECK_KEYS,
  COMPLIANCE_CHECK_STATUSES,
  evaluateOshaDecisionTree,
  classifyOshaReview
} from "../incidents.mjs";

// Wave 3, Slice 3B -- IN-13 (signatures), IN-14 (OSHA recordability decision
// tree), IN-15 (compliance checks + closure gate's supporting writes).
// Split out of incidents-routes.mjs (already 1000+ lines before this slice)
// into its own module, matching incidents-people-routes.mjs's precedent
// (P-6/IN-12): its own small set of copied-not-imported helpers
// (loadIncident/writeAuditEvent/requireAnyPerm -- none of them exported by
// incidents-routes.mjs), and every route here carries facilityId AND
// incidentId in the URL like that module's own routes do.
//
// Reads: incidents.read. Writes (sign, record/waive a compliance check,
// evaluate the OSHA tree): incidents.manage OR incidents.review, except
// waiving a compliance check, which is incidents.review alone (IN-15's
// acceptance criterion, also enforced at the RLS layer, 0056(d)) --
// matching this module's established "review is a distinct, narrower-than-
// manage governance surface that can still act on case content" design.
export function registerIncidentComplianceRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requireRead: requireReadFactory, parseJsonBody } = guards;
  const requireRead = requireReadFactory("incidents.read");

  const WRITE_CODES = ["incidents.manage", "incidents.review"];

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

  function requireReview(auth, facilityId, response) {
    return requireAuthPermission(auth, facilityId, "incidents.review").allowed
      ? true
      : (sendJson(response, 403, { error: "missing permission: incidents.review" }), false);
  }

  // Copied verbatim (behavior, not just shape) from incidents-routes.mjs's
  // own writeAuditEvent -- see that file's comment for the full rationale.
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

  const SIGNATURE_COLUMNS =
    "id,facility_id,incident_id,signer_user_id,role,attestation_text,signed_name,signature_image_path,signed_at";
  const COMPLIANCE_CHECK_COLUMNS =
    "id,facility_id,incident_id,check_key,status,notes,checked_by,checked_at";
  const INCIDENT_COLUMNS =
    "id,facility_id,department_id,incident_no,report_type,status,severity,occurred_at,reported_at," +
    "location_text,summary,immediate_actions,requires_osha_review,legal_hold,submitted_by,submitted_at," +
    "created_at,updated_at";

  async function loadIncident(client, incidentId) {
    const rows = await pgSelect(client, "incident_reports", {
      filters: { id: incidentId },
      select: INCIDENT_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolves and validates the incident named in the URL. Returns null (and
  // has already responded 404) when it does not exist or does not belong to
  // the facility in the URL -- matching incidents-people-routes.mjs's
  // resolveIncident exactly (a mismatch is a plain 404, never 403, so a
  // caller can't distinguish "wrong facility" from "no such row").
  async function resolveIncident(auth, params, response) {
    const incident = await loadIncident(auth.client, params.incidentId);
    if (!incident || incident.facility_id !== params.facilityId) {
      sendJson(response, 404, { error: "incident not found" });
      return null;
    }
    return incident;
  }

  // --- Signatures (IN-13) -----------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/incidents/:incidentId/signatures",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const rows = await pgSelect(auth.client, "incident_signatures", {
          filters: { incident_id: incident.id, facility_id: params.facilityId },
          select: SIGNATURE_COLUMNS,
          order: "signed_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Records a signature: { role, attestationText, signedName,
  // signatureImagePath? }. Shape is validated before any fetch, matching
  // this file set's own "shape-then-guard" order. A supervisor signature
  // ALSO records (upserts) a supervisor_signoff compliance check as
  // 'pass' -- IN-13's acceptance criterion ("supervisor signoff recorded as
  // an incident_compliance_checks row"), which in turn is what the closure
  // gate (evaluateClosureGate / migration 0056's guard 2.5) consults for a
  // requires_osha_review incident.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/signatures",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { role, attestationText, signedName, signatureImagePath } = body.payload;
        const shape = [];
        if (!role || !SIGNATURE_ROLES.includes(role)) {
          shape.push(`role must be one of: ${SIGNATURE_ROLES.join(", ")}`);
        }
        const attestation = validateAttestationText(attestationText);
        if (!attestation.valid) shape.push(attestation.error);
        if (!signedName || !String(signedName).trim()) shape.push("signedName is required");
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;

        if (signatureImagePath !== undefined && signatureImagePath !== null) {
          try {
            assertPathInFacility(signatureImagePath, params.facilityId, "incidents");
          } catch (error) {
            if (error instanceof StorageValidationError) {
              return sendJson(response, 400, { error: error.message });
            }
            throw error;
          }
        }

        const row = {
          facility_id: params.facilityId,
          incident_id: incident.id,
          signer_user_id: auth.claims.sub,
          role,
          attestation_text: String(attestationText).trim(),
          signed_name: String(signedName).trim(),
          signature_image_path: signatureImagePath ?? null
        };
        const rows = await pgInsert(auth.client, "incident_signatures", [row], { returning: true });
        const created = (rows ?? [])[0] ?? null;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.signed",
            payload: { actor: auth.claims.sub, signatureId: created?.id ?? null, role }
          })
        );
        if (!auditOk) return;

        if (role === "supervisor") {
          await pgInsert(
            auth.client,
            "incident_compliance_checks",
            [
              {
                facility_id: incident.facility_id,
                incident_id: incident.id,
                check_key: "supervisor_signoff",
                status: "pass",
                notes: `Recorded automatically from signature ${created?.id ?? ""}.`.trim(),
                checked_by: auth.claims.sub
              }
            ],
            { onConflict: "incident_id,check_key", merge: true, returning: false }
          );
          const checkAuditOk = await writeAuditEvent(
            auth,
            response,
            env,
            buildIncidentAuditEvent({
              facilityId: incident.facility_id,
              incidentId: incident.id,
              actorUserId: auth.claims.sub,
              eventType: "incident.compliance_check_recorded",
              payload: {
                actor: auth.claims.sub,
                checkKey: "supervisor_signoff",
                status: "pass",
                sourceSignatureId: created?.id ?? null
              }
            })
          );
          if (!checkAuditOk) return;
        }

        return sendJson(response, 201, created);
      })
  );

  // --- Compliance checks (IN-15) ------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/incidents/:incidentId/compliance-checks",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;
        const rows = await pgSelect(auth.client, "incident_compliance_checks", {
          filters: { incident_id: incident.id, facility_id: params.facilityId },
          select: COMPLIANCE_CHECK_COLUMNS,
          order: "checked_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Records (or, per a matching check_key, supersedes -- migration 0056(d)'s
  // documented upsert semantics) a compliance check: { checkKey, status,
  // notes? }. status='waived' requires incidents.review specifically (IN-15:
  // "waive requires incidents.review"), enforced here AND at the RLS layer
  // (0056(d)'s narrower waive-only policy pair) as defense in depth.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/compliance-checks",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { checkKey, status, notes } = body.payload;
        const shape = [];
        if (!checkKey || !COMPLIANCE_CHECK_KEYS.includes(checkKey)) {
          shape.push(`checkKey must be one of: ${COMPLIANCE_CHECK_KEYS.join(", ")}`);
        }
        if (!status || !COMPLIANCE_CHECK_STATUSES.includes(status)) {
          shape.push(`status must be one of: ${COMPLIANCE_CHECK_STATUSES.join(", ")}`);
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        if (status === "waived") {
          if (!requireReview(auth, params.facilityId, response)) return;
        } else if (!requireWrite(auth, params.facilityId, response)) {
          return;
        }
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;

        const row = {
          facility_id: params.facilityId,
          incident_id: incident.id,
          check_key: checkKey,
          status,
          notes: notes ?? null,
          checked_by: auth.claims.sub,
          checked_at: new Date().toISOString()
        };
        const rows = await pgInsert(auth.client, "incident_compliance_checks", [row], {
          onConflict: "incident_id,check_key",
          merge: true,
          returning: true
        });
        const created = (rows ?? [])[0] ?? row;

        const auditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.compliance_check_recorded",
            payload: {
              actor: auth.claims.sub,
              checkKey,
              status,
              notes: notes ?? null,
              waived: status === "waived"
            }
          })
        );
        if (!auditOk) return;

        return sendJson(response, 200, created);
      })
  );

  // Returns the facility's effective incidents.oshaDecisionTree (settings-
  // registry.mjs default, or a tenant override) so the review workspace's
  // OSHA questionnaire (IN-19) can walk the SAME tree the osha-evaluation
  // route below will score answers against, rather than shipping a second,
  // potentially-stale copy of the default tree to the browser. Gated on
  // incidents.read (not admin.manage, unlike the settings' own PATCH
  // surface in admin-routes.mjs) -- reading the tree to ask the right next
  // question is part of using the module, not administering it.
  router.register(
    "GET",
    "/facilities/:facilityId/incidents/osha-decision-tree",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const config = await loadModuleConfig({
          client: auth.client,
          facilityId: params.facilityId,
          moduleCode: "incidents"
        });
        return sendJson(response, 200, { tree: config["incidents.oshaDecisionTree"] ?? null });
      })
  );

  // --- OSHA recordability decision tree (IN-14) ---------------------------
  // Evaluates incidents.oshaDecisionTree (settings-registry.mjs) against
  // body.answers, records the result as a compliance check ('osha_
  // recordability'; 'pass' once a definite outcome is reached, 'fail' for
  // the tree's own "needs_more_info" fallback -- the determination itself
  // is incomplete, not that the incident failed some pass/fail test),
  // conditionally amends requires_osha_review (through
  // internal.apply_incident_amendment on a non-draft incident, per 0043/
  // 0048's guard -- amendable fields may never be UPDATEd directly once an
  // incident has left draft; a plain pgUpdate is used on a still-draft
  // incident, where that guard does not yet apply), and -- when the tree
  // says the case is recordable -- creates a regulatory-timer follow-up
  // action due at the tree's own computed deadline.
  router.register(
    "POST",
    "/facilities/:facilityId/incidents/:incidentId/osha-evaluation",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { answers } = body.payload;
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
          return sendJson(response, 400, { error: "answers must be an object" });
        }

        if (!requireWrite(auth, params.facilityId, response)) return;
        const incident = await resolveIncident(auth, params, response);
        if (!incident) return;

        const config = await loadModuleConfig({
          client: auth.client,
          facilityId: params.facilityId,
          moduleCode: "incidents"
        });
        const tree = config["incidents.oshaDecisionTree"];
        const result = evaluateOshaDecisionTree(tree, answers, new Date());

        const checkStatus = result.malformed ? "fail" : "pass";
        const checkRows = await pgInsert(
          auth.client,
          "incident_compliance_checks",
          [
            {
              facility_id: incident.facility_id,
              incident_id: incident.id,
              check_key: "osha_recordability",
              status: checkStatus,
              notes: JSON.stringify({ outcome: result.outcome, dueAt: result.dueAt, path: result.path }),
              checked_by: auth.claims.sub,
              checked_at: new Date().toISOString()
            }
          ],
          { onConflict: "incident_id,check_key", merge: true, returning: true }
        );
        const complianceCheck = (checkRows ?? [])[0] ?? null;

        const treeAuditOk = await writeAuditEvent(
          auth,
          response,
          env,
          buildIncidentAuditEvent({
            facilityId: incident.facility_id,
            incidentId: incident.id,
            actorUserId: auth.claims.sub,
            eventType: "incident.osha_evaluated",
            payload: {
              actor: auth.claims.sub,
              answers,
              outcome: result.outcome,
              recordable: result.recordable,
              dueAt: result.dueAt,
              path: result.path
            }
          })
        );
        if (!treeAuditOk) return;

        // classifyOshaReview folds the tree outcome into the module's
        // existing accident/outcomes rule (IN-14's own expansion of that
        // function) so this route never has to special-case "recordable"
        // itself for the amendment decision below.
        const shouldFlagOsha = classifyOshaReview(incident.report_type, [], result.outcome);
        let updatedIncident = incident;
        if (shouldFlagOsha && incident.requires_osha_review !== true) {
          if (incident.status === "draft") {
            const rows = await pgUpdate(
              auth.client,
              "incident_reports",
              { id: incident.id },
              { requires_osha_review: true, updated_at: new Date().toISOString() },
              { returning: true }
            );
            updatedIncident = (rows ?? [])[0] ?? incident;
          } else {
            let rpcResult;
            try {
              rpcResult = await pgRpc(auth.client, "apply_incident_amendment", {
                incident_id: incident.id,
                changes: { requires_osha_review: true },
                reason: `OSHA decision tree evaluation: outcome=${result.outcome}`
              });
            } catch (error) {
              if (error instanceof PostgrestError && (error.status === 403 || error.status === 409 || error.status === 400)) {
                return sendJson(response, error.status, { error: error.body?.message ?? "amendment rejected" });
              }
              throw error;
            }
            updatedIncident = rpcResult?.incident ?? incident;
            const amendAuditOk = await writeAuditEvent(
              auth,
              response,
              env,
              buildIncidentAuditEvent({
                facilityId: incident.facility_id,
                incidentId: incident.id,
                actorUserId: auth.claims.sub,
                eventType: "incident.amended",
                payload: {
                  actor: auth.claims.sub,
                  reason: `OSHA decision tree evaluation: outcome=${result.outcome}`,
                  fields: ["requires_osha_review"]
                }
              })
            );
            if (!amendAuditOk) return;
          }
        }

        let followup = null;
        if (result.recordable) {
          const followupRows = await pgInsert(
            auth.client,
            "incident_followup_actions",
            [
              {
                facility_id: incident.facility_id,
                incident_id: incident.id,
                owner_user_id: null,
                action_type: "documentation",
                status: "open",
                due_at: result.dueAt,
                description: `OSHA recordability regulatory timer: complete recordkeeping documentation (outcome: ${result.outcome}).`
              }
            ],
            { returning: true }
          );
          followup = (followupRows ?? [])[0] ?? null;
          const followupAuditOk = await writeAuditEvent(
            auth,
            response,
            env,
            buildIncidentAuditEvent({
              facilityId: incident.facility_id,
              incidentId: incident.id,
              actorUserId: auth.claims.sub,
              eventType: "incident.followup_created",
              payload: {
                actor: auth.claims.sub,
                followupId: followup?.id ?? null,
                actionType: "documentation",
                description: followup?.description ?? null
              }
            })
          );
          if (!followupAuditOk) return;
        }

        return sendJson(response, 200, {
          outcome: result.outcome,
          recordable: result.recordable,
          dueAt: result.dueAt,
          path: result.path,
          complianceCheck,
          incident: updatedIncident,
          followup
        });
      })
  );

  return router;
}
