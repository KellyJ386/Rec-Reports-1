import { pgSelect, pgInsert, pgUpdate } from "../supabase-rest.mjs";
import { requireAuthPermission, makeGuards } from "./guard.mjs";
import {
  validateCustomFieldInput,
  validateFormDefinition,
  buildFormDraftUpdate,
  nextVersionNo,
  buildFormPublish,
  buildFormPromotion
} from "../admin/forms.mjs";
import { loadEntitlements, isEntitled } from "../admin/entitlements.mjs";

const TEMPLATE_MANAGE = "reports.template.manage";
// Same catalog code report-templates-routes.mjs gates its publish route on
// (DR-06): promoting a form also flips a report_template_versions row's
// is_published straight to true, so it requires the same authority as
// publishing one the ordinary way, on top of reports.template.manage.
const TEMPLATE_PUBLISH = "reports.publish";
const ENTITLEMENT = "custom_forms";

const CUSTOM_FIELD_COLUMNS =
  "id,facility_id,entity_type,key,label,data_type,validation_jsonb,active,created_by,created_at,updated_at";
const FORM_COLUMNS =
  "id,facility_id,module_code,form_code,version_no,status,schema_jsonb,created_by,created_at,updated_at";
const REPORT_TEMPLATE_COLUMNS = "id,facility_id,code,name,active_version,status";

// Registers the Phase 7 Forms & Fields (lite) API routes on a router, using the
// same injected-primitives shape as registerWorkflowRoutes:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads are open to any facility member; writes require reports.template.manage
// on the row's facility (matching the RLS gates in 0015).
export function registerFormsRoutes(router, { authenticate, sendJson, readBody }) {
  const { withAuth, requireMember, parseJsonBody, queryParams } = makeGuards({
    authenticate,
    sendJson,
    readBody
  });

  function requireManage(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, TEMPLATE_MANAGE);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  function requirePublish(auth, facilityId, response) {
    const guard = requireAuthPermission(auth, facilityId, TEMPLATE_PUBLISH);
    if (!guard.allowed) {
      sendJson(response, 403, { error: guard.reason });
      return false;
    }
    return true;
  }

  async function facilityOrgId(client, facilityId) {
    const rows = await pgSelect(client, "facilities", {
      filters: { id: facilityId },
      select: "organization_id",
      limit: 1
    });
    return (rows ?? [])[0]?.organization_id ?? null;
  }

  // 402-gate a write on the custom_forms entitlement. Missing subscription ->
  // empty entitlements -> denied (fail closed), per loadEntitlements.
  async function requireEntitled(auth, facilityId, response) {
    const orgId = await facilityOrgId(auth.client, facilityId);
    const { entitlements } = await loadEntitlements(auth.client, orgId);
    if (!isEntitled(entitlements, ENTITLEMENT)) {
      sendJson(response, 402, { error: `plan does not include ${ENTITLEMENT}` });
      return false;
    }
    return true;
  }

  // --- Custom fields ---------------------------------------------------------
  router.register(
    "GET",
    "/facilities/:facilityId/custom-fields",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireMember(auth, params.facilityId, response)) return;
        const entityType = queryParams(request).get("entity_type") || undefined;
        const filters = { facility_id: params.facilityId };
        if (entityType) filters.entity_type = entityType;
        const rows = await pgSelect(auth.client, "custom_fields", {
          filters,
          select: CUSTOM_FIELD_COLUMNS,
          order: "created_at.desc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "POST",
    "/facilities/:facilityId/custom-fields",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { valid, errors } = validateCustomFieldInput(body.payload);
        if (!valid) return sendJson(response, 400, { errors });
        if (!requireManage(auth, params.facilityId, response)) return;
        if (!(await requireEntitled(auth, params.facilityId, response))) return;
        const row = {
          facility_id: params.facilityId,
          entity_type: body.payload.entityType ?? "report",
          key: body.payload.key,
          label: body.payload.label,
          data_type: body.payload.dataType,
          validation_jsonb: body.payload.validation ?? {},
          active: body.payload.active === undefined ? true : Boolean(body.payload.active),
          created_by: auth.claims.sub
        };
        const rows = await pgInsert(auth.client, "custom_fields", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // PATCH toggles active and/or edits the label of a single field. The field's
  // facility is loaded first so the manage guard runs on the right facility.
  router.register("PATCH", "/custom-fields/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const existing = (
        await pgSelect(auth.client, "custom_fields", {
          filters: { id: params.id },
          select: CUSTOM_FIELD_COLUMNS,
          limit: 1
        })
      )?.[0];
      if (!existing) return sendJson(response, 404, { error: "custom field not found" });
      if (!requireManage(auth, existing.facility_id, response)) return;
      if (!(await requireEntitled(auth, existing.facility_id, response))) return;
      const patch = {};
      if (body.payload.active !== undefined) patch.active = Boolean(body.payload.active);
      if (body.payload.label !== undefined) {
        if (typeof body.payload.label !== "string" || body.payload.label.trim().length === 0) {
          return sendJson(response, 400, { errors: ["label must be a non-empty string"] });
        }
        patch.label = body.payload.label;
      }
      if (Object.keys(patch).length === 0) {
        return sendJson(response, 400, { error: "nothing to update (send active and/or label)" });
      }
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(auth.client, "custom_fields", { id: params.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // --- Form definitions ------------------------------------------------------
  router.register("GET", "/facilities/:facilityId/forms", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      if (!requireMember(auth, params.facilityId, response)) return;
      const moduleCode = queryParams(request).get("module") || undefined;
      const filters = { facility_id: params.facilityId };
      if (moduleCode) filters.module_code = moduleCode;
      const rows = await pgSelect(auth.client, "form_definitions", {
        filters,
        select: FORM_COLUMNS,
        order: "form_code.asc,version_no.desc"
      });
      return sendJson(response, 200, rows ?? []);
    })
  );

  // POST creates a new draft. When the form_code already exists, the draft
  // lands on version = max(existing) + 1; otherwise version 1.
  router.register("POST", "/facilities/:facilityId/forms", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const { valid, errors } = validateFormDefinition({
        moduleCode: body.payload.moduleCode,
        formCode: body.payload.formCode,
        schema: body.payload.schema
      });
      if (!valid) return sendJson(response, 400, { errors });
      if (!requireManage(auth, params.facilityId, response)) return;
      if (!(await requireEntitled(auth, params.facilityId, response))) return;
      const existing = await pgSelect(auth.client, "form_definitions", {
        filters: { facility_id: params.facilityId, form_code: body.payload.formCode },
        select: "version_no"
      });
      const row = {
        facility_id: params.facilityId,
        module_code: body.payload.moduleCode,
        form_code: body.payload.formCode,
        version_no: nextVersionNo(existing ?? []),
        status: "draft",
        schema_jsonb: body.payload.schema,
        created_by: auth.claims.sub
      };
      const rows = await pgInsert(auth.client, "form_definitions", [row], { returning: true });
      return sendJson(response, 201, (rows ?? [])[0] ?? null);
    })
  );

  // PATCH /forms/:id updates a draft version's schema in place so the builder
  // canvas can iterate on a draft without minting a new version per save.
  // Guards run on the loaded row's facility; buildFormDraftUpdate rejects
  // non-drafts (409) and invalid schemas (400).
  router.register("PATCH", "/forms/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const target = (
        await pgSelect(auth.client, "form_definitions", {
          filters: { id: params.id },
          select: FORM_COLUMNS,
          limit: 1
        })
      )?.[0];
      if (!target) return sendJson(response, 404, { error: "form definition not found" });
      if (!requireManage(auth, target.facility_id, response)) return;
      if (!(await requireEntitled(auth, target.facility_id, response))) return;
      const plan = buildFormDraftUpdate(target, body.payload.schema);
      if (plan.errors) return sendJson(response, 400, { errors: plan.errors });
      if (plan.error) return sendJson(response, 409, { error: plan.error });
      const patch = { ...plan.target.patch, updated_at: new Date().toISOString() };
      const rows = await pgUpdate(auth.client, "form_definitions", { id: plan.target.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // POST /forms/:id/publish publishes this version and retires every other
  // currently-published version of the same form_code (buildFormPublish shapes
  // the patch list; only drafts can be published).
  router.register("POST", "/forms/:id/publish", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const target = (
        await pgSelect(auth.client, "form_definitions", {
          filters: { id: params.id },
          select: FORM_COLUMNS,
          limit: 1
        })
      )?.[0];
      if (!target) return sendJson(response, 404, { error: "form definition not found" });
      if (!requireManage(auth, target.facility_id, response)) return;
      if (!(await requireEntitled(auth, target.facility_id, response))) return;
      const siblings = await pgSelect(auth.client, "form_definitions", {
        filters: { facility_id: target.facility_id, form_code: target.form_code, status: "published" },
        select: FORM_COLUMNS
      });
      const plan = buildFormPublish(target, siblings ?? []);
      if (plan.error) return sendJson(response, 409, { error: plan.error });
      for (const retirement of plan.retirements) {
        await pgUpdate(auth.client, "form_definitions", { id: retirement.id }, retirement.patch, {
          returning: false
        });
      }
      const rows = await pgUpdate(auth.client, "form_definitions", { id: plan.target.id }, plan.target.patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // POST /forms/:id/promote (DR-06) materializes a published daily_reports
  // form into the report_templates/report_template_versions governance store
  // (src/lib/report-templates.mjs), so the runtime submission path and
  // downstream report tooling can consume it as an ordinary template version.
  // form_definitions stays the only authoring surface -- this never edits the
  // form, it only mints/updates the parallel published-template record.
  //
  // Guarded on reports.template.manage AND reports.publish (matching
  // report-templates-routes.mjs's own publish route, since this route also
  // flips a version's is_published straight to true), same as every other
  // write here it also inherits the custom_forms entitlement gate (402) --
  // that gate exists for form *authoring* and this route was deliberately
  // left inside it rather than carved out; plans/DAILY_REPORTS_PLAN.md flags
  // that packaging question for the module owner to revisit.
  //
  // Write ordering (required by 0028's triggers on report_templates /
  // report_template_versions):
  //   1. resolve the target template: load by (facility_id, code=form_code);
  //      if none exists, INSERT a new draft report_templates row first --
  //      its id must exist before a version can reference it via template_id.
  //   2. INSERT the new report_template_versions row with is_published=true
  //      directly (the immutability trigger only fires on UPDATE when
  //      OLD.is_published, so an INSERT that is already published is legal
  //      and skips a separate publish step).
  //   3. UPDATE the template's active_version/status to point at that version
  //      -- only now, because fn_report_template_active_version_published
  //      requires a matching *published* version to already exist when
  //      active_version is set.
  // Re-promoting the same form_code after a re-publish repeats this against
  // the now-existing template, minting version n+1 and moving active_version
  // forward (buildFormPromotion numbers it via nextTemplateVersionNumber over
  // the template's existing versions).
  router.register("POST", "/forms/:id/promote", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const form = (
        await pgSelect(auth.client, "form_definitions", {
          filters: { id: params.id },
          select: FORM_COLUMNS,
          limit: 1
        })
      )?.[0];
      if (!form) return sendJson(response, 404, { error: "form definition not found" });
      if (!requireManage(auth, form.facility_id, response)) return;
      if (!requirePublish(auth, form.facility_id, response)) return;
      if (!(await requireEntitled(auth, form.facility_id, response))) return;

      const existingTemplate = (
        await pgSelect(auth.client, "report_templates", {
          filters: { facility_id: form.facility_id, code: form.form_code },
          select: REPORT_TEMPLATE_COLUMNS,
          limit: 1
        })
      )?.[0] ?? null;
      const existingVersions = existingTemplate
        ? await pgSelect(auth.client, "report_template_versions", {
            filters: { template_id: existingTemplate.id },
            select: "version_number"
          })
        : [];

      const plan = buildFormPromotion(form, existingTemplate, existingVersions ?? []);
      if (plan.error) return sendJson(response, 409, { error: plan.error });

      let templateId;
      if (plan.templateRow) {
        const templateRows = await pgInsert(auth.client, "report_templates", [plan.templateRow], {
          returning: true
        });
        templateId = (templateRows ?? [])[0]?.id;
      } else {
        templateId = plan.templatePatch.id;
      }

      const versionRows = await pgInsert(
        auth.client,
        "report_template_versions",
        [{ ...plan.versionRow, template_id: templateId }],
        { returning: true }
      );

      const activatePatch = plan.templatePatch
        ? plan.templatePatch.patch
        : { active_version: plan.versionRow.version_number, status: "published" };
      const templateRows = await pgUpdate(
        auth.client,
        "report_templates",
        { id: templateId },
        { ...activatePatch, updated_at: new Date().toISOString() },
        { returning: true }
      );

      return sendJson(response, 201, {
        template: (templateRows ?? [])[0] ?? null,
        version: (versionRows ?? [])[0] ?? null
      });
    })
  );

  return router;
}
