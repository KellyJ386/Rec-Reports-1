// TR-09 / TR-10: end-user API for training auto-assignment rules and for
// converting incident training triggers into assignments (0066).
//
//   GET   /facilities/:facilityId/training-rules                    (training.read)
//   POST  /facilities/:facilityId/training-rules                    (training.manage)
//   PATCH /training-rules/:id                                       (training.manage)
//   GET   /facilities/:facilityId/incident-training-triggers        (training.manage)
//   POST  /incident-training-triggers/:id/assign                    (training.manage)
//
// TR-10 builds ON 3B's incident_training_triggers (0058): a trigger is
// recorded by any incident manager/reviewer and becomes an assignment either
// directly (3B's own route, when the recorder also held training.manage) or
// through POST .../assign here, for a training manager. The conversion is
// idempotent -- UNIQUE(trigger_id) on incident_training_trigger_conversions
// plus the assignment's own (employee, course, 'incident_rule', trigger id)
// key -- and audited by the fn_audit_admin_change trigger on that table.
import { pgSelect, pgInsert, PostgrestError, pgUpdate } from "../supabase-rest.mjs";
import { makeGuards } from "./guard.mjs";
import {
  validateRuleInput,
  validateRulePatch,
  triggerState,
  resolveTriggerCourse
} from "../training-rules.mjs";

const READ = "training.read";
const MANAGE = "training.manage";

const RULE_COLUMNS =
  "id,facility_id,rule_type,certification_type_id,role_id,course_id,gap_statuses,due_days,active,last_evaluated_at,created_at,updated_at";
const TRIGGER_COLUMNS = "id,facility_id,incident_id,employee_id,target,reason,created_by,created_at";
const ASSIGNMENT_COLUMNS =
  "id,facility_id,employee_id,course_id,assigned_by,assigned_at,due_at,reason_code,source_type,source_ref_id";
const CONVERSION_COLUMNS = "id,facility_id,trigger_id,assignment_id,converted_by,converted_at";
const MAX_TRIGGER_LIST = 200;

export function registerTrainingAutomationRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams } = guards;
  const requireRead = guards.requireRead(READ);

  async function rowExists(client, table, id, facilityId) {
    const rows = await pgSelect(client, table, { filters: { id, facility_id: facilityId }, select: "id", limit: 1 });
    return (rows ?? []).length > 0;
  }

  // --- Rules (TR-09) -------------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/training-rules",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const rows = await pgSelect(auth.client, "training_assignment_rules", {
          filters: { facility_id: params.facilityId },
          select: RULE_COLUMNS,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/training-rules",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateRuleInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;

        // Same-facility references are enforced by RLS too; resolving them
        // here turns a would-be opaque denial into a clear 400.
        const p = body.payload;
        const refChecks = [
          ["courseId", "courses", p.courseId],
          ["certificationTypeId", "certification_types", p.certificationTypeId],
          ["roleId", "roles", p.roleId]
        ];
        for (const [label, table, id] of refChecks) {
          if (id && !(await rowExists(auth.client, table, id, params.facilityId))) {
            return sendJson(response, 400, { errors: [`${label} was not found in this facility`] });
          }
        }

        const row = {
          facility_id: params.facilityId,
          rule_type: p.ruleType,
          certification_type_id: p.ruleType === "certification" ? p.certificationTypeId : null,
          role_id: p.roleId ?? null,
          course_id: p.courseId,
          due_days: p.dueDays ?? null,
          created_by: auth.claims.sub
        };
        if (p.gapStatuses !== undefined) row.gap_statuses = p.gapStatuses;
        try {
          const rows = await pgInsert(auth.client, "training_assignment_rules", [row], { returning: true });
          return sendJson(response, 201, (rows ?? [])[0] ?? null);
        } catch (error) {
          if (error instanceof PostgrestError && error.status === 409) {
            return sendJson(response, 409, { error: "an identical rule already exists for this facility" });
          }
          throw error;
        }
      })
  );

  router.register(
    "PATCH",
    "/training-rules/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateRulePatch(body.payload);
        if (!valid) return sendJson(response, 400, { errors });

        const found = await pgSelect(auth.client, "training_assignment_rules", {
          filters: { id: params.id },
          select: RULE_COLUMNS,
          limit: 1
        });
        const rule = (found ?? [])[0] ?? null;
        if (!rule) return sendJson(response, 404, { error: "training rule not found" });
        if (!requirePerm(auth, rule.facility_id, MANAGE, response)) return;

        const patch = {};
        if (body.payload.active !== undefined) patch.active = body.payload.active;
        if (body.payload.dueDays !== undefined) patch.due_days = body.payload.dueDays;
        if (body.payload.gapStatuses !== undefined) {
          if (rule.rule_type !== "certification") {
            return sendJson(response, 400, { errors: ["gapStatuses only applies to a certification rule"] });
          }
          patch.gap_statuses = body.payload.gapStatuses;
        }
        if (Object.keys(patch).length === 0) return sendJson(response, 400, { error: "nothing to update" });
        patch.updated_at = new Date().toISOString();
        const rows = await pgUpdate(
          auth.client,
          "training_assignment_rules",
          { id: rule.id, facility_id: rule.facility_id },
          patch,
          { returning: true }
        );
        return sendJson(response, 200, (rows ?? [])[0] ?? null);
      })
  );

  // --- Incident training triggers (TR-10) ----------------------------------
  // Lists the facility's recorded triggers with their conversion state.
  // ?state=pending (default) | assigned | all.
  router.register(
    "GET",
    "/facilities/:facilityId/incident-training-triggers",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requirePerm(auth, params.facilityId, MANAGE, response)) return;
        const wanted = queryParams(request).get("state") ?? "pending";
        if (!["pending", "assigned", "all"].includes(wanted)) {
          return sendJson(response, 400, { error: "state must be one of: pending, assigned, all" });
        }

        const triggers =
          (await pgSelect(auth.client, "incident_training_triggers", {
            filters: { facility_id: params.facilityId },
            select: TRIGGER_COLUMNS,
            order: "created_at.desc",
            limit: MAX_TRIGGER_LIST
          })) ?? [];
        if (triggers.length === 0) return sendJson(response, 200, []);
        const triggerIds = triggers.map((trigger) => trigger.id);

        const certTypeIds = [
          ...new Set(triggers.map((trigger) => trigger.target?.certificationTypeId).filter(Boolean))
        ];
        const [conversions, assignments, employees, certTypes] = await Promise.all([
          pgSelect(auth.client, "incident_training_trigger_conversions", {
            filters: { facility_id: params.facilityId, trigger_id: { in: triggerIds } },
            select: CONVERSION_COLUMNS
          }),
          pgSelect(auth.client, "training_assignments", {
            filters: { facility_id: params.facilityId, source_type: "incident_rule", source_ref_id: { in: triggerIds } },
            select: ASSIGNMENT_COLUMNS,
            extra: { deleted_at: "is.null" }
          }),
          pgSelect(auth.client, "employees", {
            filters: { facility_id: params.facilityId, id: { in: [...new Set(triggers.map((trigger) => trigger.employee_id))] } },
            select: "id,first_name,last_name"
          }),
          certTypeIds.length === 0
            ? []
            : pgSelect(auth.client, "certification_types", {
                filters: { facility_id: params.facilityId, id: { in: certTypeIds } },
                select: "id,code,name"
              })
        ]);
        const certTypeById = new Map((certTypes ?? []).map((row) => [row.id, row]));
        const conversionByTrigger = new Map((conversions ?? []).map((row) => [row.trigger_id, row]));
        const assignmentByTrigger = new Map((assignments ?? []).map((row) => [row.source_ref_id, row]));
        const employeeById = new Map((employees ?? []).map((row) => [row.id, row]));

        const shaped = triggers
          .map((trigger) => {
            const { state, assignmentId } = triggerState(trigger, { conversionByTrigger, assignmentByTrigger });
            const employee = employeeById.get(trigger.employee_id);
            return {
              id: trigger.id,
              incidentId: trigger.incident_id,
              employeeId: trigger.employee_id,
              employeeName: employee ? `${employee.first_name} ${employee.last_name}` : null,
              target: trigger.target,
              certificationTypeName: certTypeById.get(trigger.target?.certificationTypeId)?.name ?? null,
              reason: trigger.reason,
              createdAt: trigger.created_at,
              state,
              assignmentId
            };
          })
          .filter((trigger) => wanted === "all" || trigger.state === wanted);
        return sendJson(response, 200, shaped);
      })
  );

  // Converts one recorded trigger into a training assignment. Body (all
  // optional): { courseId, dueAt }. Idempotent: an already-converted trigger
  // (a conversion row, or an incident_rule assignment 3B's route already
  // created) answers 200 { created: false } with the existing rows, and a
  // lost race on either unique key re-reads instead of failing.
  router.register(
    "POST",
    "/incident-training-triggers/:id/assign",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { courseId, dueAt } = body.payload ?? {};
        const shape = [];
        if (courseId !== undefined && courseId !== null && typeof courseId !== "string") shape.push("courseId must be a string");
        if (dueAt !== undefined && dueAt !== null && (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt)))) {
          shape.push("dueAt must be an ISO timestamp");
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });

        const found = await pgSelect(auth.client, "incident_training_triggers", {
          filters: { id: params.id },
          select: TRIGGER_COLUMNS,
          limit: 1
        });
        const trigger = (found ?? [])[0] ?? null;
        if (!trigger) return sendJson(response, 404, { error: "incident training trigger not found" });
        if (!requirePerm(auth, trigger.facility_id, MANAGE, response)) return;

        async function loadConversion() {
          const rows = await pgSelect(auth.client, "incident_training_trigger_conversions", {
            filters: { trigger_id: trigger.id, facility_id: trigger.facility_id },
            select: CONVERSION_COLUMNS,
            limit: 1
          });
          return (rows ?? [])[0] ?? null;
        }
        async function loadTriggerAssignment() {
          const rows = await pgSelect(auth.client, "training_assignments", {
            filters: {
              facility_id: trigger.facility_id,
              employee_id: trigger.employee_id,
              source_type: "incident_rule",
              source_ref_id: trigger.id
            },
            select: ASSIGNMENT_COLUMNS,
            extra: { deleted_at: "is.null" },
            limit: 1
          });
          return (rows ?? [])[0] ?? null;
        }

        const existingConversion = await loadConversion();
        if (existingConversion) {
          const assignmentRows = await pgSelect(auth.client, "training_assignments", {
            filters: { id: existingConversion.assignment_id, facility_id: trigger.facility_id },
            select: ASSIGNMENT_COLUMNS,
            limit: 1
          });
          return sendJson(response, 200, {
            created: false,
            conversion: existingConversion,
            assignment: (assignmentRows ?? [])[0] ?? null
          });
        }

        let assignment = await loadTriggerAssignment();
        let created = false;
        if (!assignment) {
          let moduleCourseId = null;
          if (trigger.target?.trainingModuleId) {
            const moduleRows = await pgSelect(auth.client, "course_modules", {
              filters: { id: trigger.target.trainingModuleId, facility_id: trigger.facility_id },
              select: "id,course_id",
              limit: 1
            });
            moduleCourseId = (moduleRows ?? [])[0]?.course_id ?? null;
          }
          const certificationRules = trigger.target?.certificationTypeId
            ? ((await pgSelect(auth.client, "training_assignment_rules", {
                filters: {
                  facility_id: trigger.facility_id,
                  rule_type: "certification",
                  certification_type_id: trigger.target.certificationTypeId,
                  active: true
                },
                select: RULE_COLUMNS
              })) ?? [])
            : [];
          const resolved = resolveTriggerCourse(trigger, { courseId, moduleCourseId, certificationRules });
          if (resolved.error) return sendJson(response, 409, { error: resolved.error });
          if (!(await rowExists(auth.client, "courses", resolved.courseId, trigger.facility_id))) {
            return sendJson(response, 400, { errors: ["courseId was not found in this facility"] });
          }
          if (!(await rowExists(auth.client, "employees", trigger.employee_id, trigger.facility_id))) {
            return sendJson(response, 409, { error: "the trigger's employee no longer exists in this facility" });
          }

          try {
            const rows = await pgInsert(
              auth.client,
              "training_assignments",
              [
                {
                  facility_id: trigger.facility_id,
                  employee_id: trigger.employee_id,
                  course_id: resolved.courseId,
                  assigned_by: auth.claims.sub,
                  due_at: dueAt ?? null,
                  reason_code: "incident_training_trigger",
                  source_type: "incident_rule",
                  source_ref_id: trigger.id
                }
              ],
              { returning: true }
            );
            assignment = (rows ?? [])[0] ?? null;
            created = true;
          } catch (error) {
            if (!(error instanceof PostgrestError && error.status === 409)) throw error;
            // lost a race with another conversion (or 3B's route): re-read.
            assignment = await loadTriggerAssignment();
            if (!assignment) throw error;
          }
        }

        let conversion = null;
        try {
          const rows = await pgInsert(
            auth.client,
            "incident_training_trigger_conversions",
            [
              {
                facility_id: trigger.facility_id,
                trigger_id: trigger.id,
                assignment_id: assignment.id,
                converted_by: auth.claims.sub
              }
            ],
            { returning: true }
          );
          conversion = (rows ?? [])[0] ?? null;
        } catch (error) {
          if (!(error instanceof PostgrestError && error.status === 409)) throw error;
          conversion = await loadConversion();
          created = false;
        }
        return sendJson(response, created ? 201 : 200, { created, conversion, assignment });
      })
  );

  return router;
}
