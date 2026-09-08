import { createHash } from "node:crypto";
import { pgSelect, pgInsert, pgUpdate, pgRpc } from "../supabase-rest.mjs";
import { makeGuards } from "./guard.mjs";
import { hasDepartmentPermission } from "../permissions.mjs";
import {
  validateReportSubmission,
  validateReportSubmissionPartial,
  unknownPayloadKeys,
  hiddenFieldKeys,
  stripHiddenFields,
  normalizeSignatureRoleRequirement
} from "../report-schema.mjs";
import { computeCompliance, dateRange } from "../reports-compliance.mjs";
import { buildReportPdfPackage } from "../admin/report-pdf.mjs";
import { loadModuleConfig } from "./module-config.mjs";
import { flagState } from "../admin/entitlements.mjs";
import { isSandboxTemplate } from "../report-templates.mjs";
import {
  createStorageClientFromEnv,
  assertPathInFacility,
  createSignedUrl,
  StorageValidationError
} from "../storage.mjs";

const READ = "reports.read";
const CREATE = "reports.create";
const SUBMIT = "reports.submit";
const EXPORT = "reports.export";
// DR-24: lock/revise reuse reports.publish rather than a new reports.lock
// code -- see 0055_report_lifecycle.sql's header for the full justification
// (same "makes this record official and hard to undo" governance tier as
// publishing a template version).
const PUBLISH = "reports.publish";
const PDF_EXPORT_FLAG = "reports.pdf_export";
// DR-23: TTL for a signed URL onto the immutable PDF snapshot -- same 300s
// used by attachments-routes.mjs/training-routes.mjs for every other
// short-lived Storage read.
const SNAPSHOT_SIGNED_URL_TTL_SECONDS = 300;

const TEMPLATE_COLUMNS =
  "id,facility_id,department_id,code,name,description,status,active_version,sandbox,created_at,updated_at";
const VERSION_COLUMNS =
  "id,facility_id,template_id,version_number,schema_json,validation_json,is_published,created_at";
const SUBMISSION_COLUMNS =
  "id,facility_id,department_id,template_id,template_version_id,report_date,shift_ref,status," +
  "submitted_by,submitted_at,payload_json,validation_results,source,revision_of," +
  "pdf_status,pdf_storage_path,pdf_content_hash,pdf_attempts,pdf_error,created_at,updated_at";
const ATTACHMENT_COLUMNS =
  "id,facility_id,submission_id,field_key,storage_path,mime_type,checksum,metadata,created_at";
// L-1 (security review): report_submission_signatures (0052) has no
// created_at column -- selecting it made PostgREST answer the whole request
// with a 400, so this route was broken in production despite the unit tests
// (which stub the client) passing. signed_at is that table's own timestamp
// column and was already selected below.
const SIGNATURE_COLUMNS = "id,facility_id,submission_id,signer_user_id,signer_role,signed_at,signature_hash";

// Deterministic (key-sorted) JSON stringification, so signatureHash below
// hashes the same payload_json object identically regardless of the wire/DB
// round-trip's own key order -- object key order is not part of jsonb's
// equality semantics, but it WOULD change the raw string this hashes if left
// unsorted, which would make an unrelated re-fetch look like a payload
// change.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// DR-17: signature_hash = sha256(`${submissionId}|${userId}|${role}|${sha256(payload)}`)
// so a later edit to the submission's payload_json is detectable against a
// previously-recorded signature without storing the payload itself a second
// time. payload_json is folded into the outer hash as its own hash (rather
// than inlined raw) so an arbitrarily large payload never inflates the
// signed composite string.
// Exported (only) so tests can build a fixture signature row whose hash
// matches a given payload -- M-2's stale-signature check recomputes this
// exact function against the CURRENT payload_json at submit time, so a test
// fixture that wants to exercise the "still fresh" path needs to produce a
// hash this same algorithm would accept.
export function signatureHash({ submissionId, userId, role, payload }) {
  const payloadHash = createHash("sha256").update(canonicalJson(payload ?? {})).digest("hex");
  const composite = `${submissionId}|${userId}|${role}|${payloadHash}`;
  return createHash("sha256").update(composite).digest("hex");
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Matches the report_submissions.status check constraint in 0002.
const VALID_STATUSES = new Set(["draft", "submitted", "locked", "revised"]);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SUBMIT_POLICY = "strict_block";

// Returns the payload key -> error-message helper shape used by every
// unknown-key rejection below, so create/PATCH/submit report the same way.
function unknownKeysError(schema, payload) {
  const unknown = unknownPayloadKeys(schema, payload);
  if (unknown.length === 0) return null;
  return { errors: [`payload has unknown keys not defined on the template version: ${unknown.join(", ")}`] };
}

// Registers the end-user Daily Reports API routes on a router, using the same
// injected-primitives shape as the admin route modules:
//   authenticate(request, env) -> { claims, client, memberships, error }
//   sendJson(response, status, payload)
//   readBody(request) -> Promise<string>
//
// Reads require reports.read on the row's facility; creating a draft requires
// reports.create; editing or submitting a draft requires reports.submit. Once a
// submission leaves 'draft' it is immutable here (matching the RLS gate in 0002,
// which only permits updates while status = 'draft').
export function registerReportRoutes(router, { authenticate, sendJson, readBody }) {
  const guards = makeGuards({ authenticate, sendJson, readBody });
  const { withAuth, requirePerm, parseJsonBody, queryParams, parseListLimitOffset } = guards;
  const requireRead = guards.requireRead(READ);

  // --- Department-scoped guards (DR-11) ---------------------------------
  // 0033 switched report_templates SELECT and report_submissions
  // INSERT/UPDATE to the 4-arg has_permission(user, facility, department,
  // code) overload (0023), so a membership scoped to one department can file
  // and read reports for that department without being a facility-wide
  // member. These mirror that at the route layer with hasDepartmentPermission
  // on the row's own department_id -- template.department_id for templates,
  // submission.department_id for submissions. A null department_id (a
  // facility-wide template/submission) only ever passes for a facility-wide
  // membership, exactly like the SQL overload (0023's own doc comment).
  //
  // requireAnyPermission is a coarse PRE-fetch gate: "does this caller hold
  // `code` via ANY active membership in this facility, department-scoped or
  // not" -- used before the row (and its department_id) is known, so a
  // caller with no membership/permission at all still gets a fast 403
  // without an extra round trip, exactly like the old facility-wide-only
  // check did. It does not by itself decide access to a specific row; that
  // is requireRowDeptPermission's job once the row is loaded.
  function requireAnyPermission(auth, facilityId, code, response) {
    if (auth?.platformAdmin === true) return true;
    const ok = (auth?.memberships ?? []).some(
      (membership) =>
        membership.facilityId === facilityId &&
        membership.status === "active" &&
        (membership.permissions ?? []).includes(code)
    );
    if (!ok) {
      sendJson(response, 403, { error: `missing permission: ${code}` });
      return false;
    }
    return true;
  }

  function requireRowDeptPermission(auth, facilityId, departmentId, code, response) {
    if (auth?.platformAdmin === true) return true;
    if (hasDepartmentPermission(auth?.memberships ?? [], facilityId, departmentId ?? null, code)) {
      return true;
    }
    sendJson(response, 403, { error: `missing permission: ${code}` });
    return false;
  }

  async function loadTemplate(client, facilityId, templateId) {
    const rows = await pgSelect(client, "report_templates", {
      filters: { id: templateId, facility_id: facilityId },
      select: TEMPLATE_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Resolves the schema to validate a submission against: the template's active
  // published version. Returns { version, schema } or null when unresolved.
  async function loadActiveVersion(client, template) {
    if (!template.active_version) return null;
    const rows = await pgSelect(client, "report_template_versions", {
      filters: { template_id: template.id, version_number: template.active_version },
      select: VERSION_COLUMNS,
      limit: 1
    });
    const version = (rows ?? [])[0] ?? null;
    if (!version) return null;
    return { version, schema: version.schema_json };
  }

  async function loadSubmission(client, submissionId) {
    const rows = await pgSelect(client, "report_submissions", {
      filters: { id: submissionId },
      select: SUBMISSION_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // Loads the exact template version a submission is pinned to (as opposed to
  // loadActiveVersion, which resolves the template's *current* active
  // version). Used to validate/edit a draft, and to render/inspect a
  // submission against the schema it was actually filled against.
  async function loadVersionById(client, versionId) {
    const rows = await pgSelect(client, "report_template_versions", {
      filters: { id: versionId },
      select: VERSION_COLUMNS,
      limit: 1
    });
    return (rows ?? [])[0] ?? null;
  }

  // --- Workflow (DR-18/DR-19/H-1) -----------------------------------------
  // H-1 (security review): this route used to derive the workflow's action
  // list itself (evaluateWorkflow) and hand it to
  // internal.enqueue_report_workflow(submission_id, actions) as a caller-
  // supplied jsonb array. That RPC re-checked reports.submit but never
  // validated the action list at all, so any reports.submit holder could
  // call public.enqueue_report_workflow directly through PostgREST with an
  // arbitrary action array and mint incidents/work orders/manager
  // notifications the template's own workflow_json never configured, with
  // no incidents.manage/work_orders.manage of their own. Fixed by moving
  // derivation entirely server-side: internal.enqueue_report_workflow (0053)
  // now takes ONLY p_submission_id, inserts exactly one 'evaluate' event
  // (idempotent -- a second call is a no-op, closing M-4 too), and
  // report-workflow-executor.mjs's executor -- running under the
  // service-role client, which the caller can never impersonate -- is what
  // loads the pinned version's workflow_json and runs evaluateWorkflow.
  // There is nothing left here for a caller to inject.
  async function enqueueWorkflow(client, { submission }) {
    try {
      // DR-26/L-6: a sandbox template (report_templates.sandbox, 0055)
      // produces no side effects at all -- no workflow events and no
      // report.submitted outbox event, so distribution (DR-22) never sees
      // it either. L-6: the prior version re-read the template row under
      // the CALLER's own RLS session and treated a lookup that returned
      // zero rows (e.g. a reports.submit holder who does not separately
      // hold reports.read on report_templates) the same as "not sandbox" --
      // failing OPEN. This now fails CLOSED: any lookup that does not come
      // back with a resolvable, non-sandbox template row (an RLS-narrowed
      // empty result, a missing row, or the pgSelect itself throwing, which
      // the outer catch below turns into "do not enqueue" as well) skips
      // enqueueing entirely, rather than assuming the template is safe.
      const templateRows = await pgSelect(client, "report_templates", {
        filters: { id: submission.template_id },
        select: "id,sandbox",
        limit: 1
      });
      const template = (templateRows ?? [])[0] ?? null;
      if (!template || isSandboxTemplate(template)) return;
      await pgRpc(client, "enqueue_report_workflow", { p_submission_id: submission.id });
    } catch {
      // Intentionally swallowed -- see this function's own doc comment.
      // report_workflow_events has no authenticated-writable path for this
      // route to fall back to (0053: no insert policy for authenticated),
      // so there is nothing further to record here beyond what the RPC
      // itself already persists on a partial success; a total failure
      // (e.g. the RPC call never reaching PostgREST) leaves no workflow
      // events for this submission, which the drain's absence of activity
      // already makes visible operationally.
    }
  }

  // --- Templates -------------------------------------------------------------
  // Lists templates a member may fill. Defaults to published only; ?status=all
  // returns every status for authors building/reviewing templates. Gated by
  // the coarse requireAnyPermission (DR-11): a department-scoped member's
  // read is narrowed per-row by 0033's RLS policy, not by this list guard,
  // since a list has no single row to test hasDepartmentPermission against.
  router.register(
    "GET",
    "/facilities/:facilityId/report-templates",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireAnyPermission(auth, params.facilityId, READ, response)) return;
        const wantAll = queryParams(request).get("status") === "all";
        const filters = { facility_id: params.facilityId };
        if (!wantAll) filters.status = "published";
        const rows = await pgSelect(auth.client, "report_templates", {
          filters,
          select: TEMPLATE_COLUMNS,
          order: "name.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // Returns a single template together with its active published version schema,
  // so the client can render the fill form. Two-phase guard (DR-11): a coarse
  // requireAnyPermission before the fetch (so a caller with no reports.read
  // membership at all still gets a fast 403), then requireRowDeptPermission
  // once the template's own department_id is known, mirroring 0033's
  // department-scoped SELECT policy on report_templates.
  router.register(
    "GET",
    "/facilities/:facilityId/report-templates/:templateId",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireAnyPermission(auth, params.facilityId, READ, response)) return;
        const template = await loadTemplate(auth.client, params.facilityId, params.templateId);
        if (!template) return sendJson(response, 404, { error: "report template not found" });
        if (!requireRowDeptPermission(auth, params.facilityId, template.department_id, READ, response)) return;
        const active = await loadActiveVersion(auth.client, template);
        return sendJson(response, 200, {
          ...template,
          active_version_id: active?.version.id ?? null,
          schema_json: active?.schema ?? null
        });
      })
  );

  // --- Submissions -----------------------------------------------------------
  // Lists submissions for a facility. Optional ?status=, ?template_id=,
  // ?department_id=, ?submitted_by= narrow the list; ?from=/?to= bound
  // report_date (inclusive, YYYY-MM-DD); ?limit=/?offset= page the results —
  // limit defaults to 50 and is capped at 200 so a list can never come back
  // unbounded. Newest report_date first.
  router.register(
    "GET",
    "/facilities/:facilityId/reports",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const filters = { facility_id: params.facilityId };

        const status = qp.get("status");
        if (status) {
          if (!VALID_STATUSES.has(status)) {
            return sendJson(response, 400, {
              error: `invalid status; must be one of: ${[...VALID_STATUSES].join(", ")}`
            });
          }
          filters.status = status;
        }

        const templateId = qp.get("template_id");
        if (templateId) filters.template_id = templateId;

        const departmentId = qp.get("department_id");
        if (departmentId) filters.department_id = departmentId;

        const submittedBy = qp.get("submitted_by");
        if (submittedBy) filters.submitted_by = submittedBy;

        const from = qp.get("from");
        if (from) {
          if (!DATE_PATTERN.test(from)) return sendJson(response, 400, { error: "from must be YYYY-MM-DD" });
          filters.report_date = { ...(filters.report_date ?? {}), gte: from };
        }
        const to = qp.get("to");
        if (to) {
          if (!DATE_PATTERN.test(to)) return sendJson(response, 400, { error: "to must be YYYY-MM-DD" });
          filters.report_date = { ...(filters.report_date ?? {}), lte: to };
        }

        const paging = parseListLimitOffset(qp, { defaultLimit: DEFAULT_LIST_LIMIT, maxLimit: MAX_LIST_LIMIT });
        if (!paging.ok) return sendJson(response, 400, { error: paging.error });

        const rows = await pgSelect(auth.client, "report_submissions", {
          filters,
          select: SUBMISSION_COLUMNS,
          order: "report_date.desc",
          limit: paging.limit,
          offset: paging.offset
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  router.register(
    "GET",
    "/reports/:id",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const submission = await loadSubmission(auth.client, params.id);
        if (!submission) return sendJson(response, 404, { error: "report not found" });
        if (!requireRead(auth, submission.facility_id, response)) return;
        return sendJson(response, 200, submission);
      })
  );

  // Detail view: the submission plus its *pinned* version's schema (so a
  // re-published template never relabels an old submission), the template's
  // name, and the submission's attachments.
  router.register(
    "GET",
    "/reports/:id/detail",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const submission = await loadSubmission(auth.client, params.id);
        if (!submission) return sendJson(response, 404, { error: "report not found" });
        if (!requireRead(auth, submission.facility_id, response)) return;

        const version = await loadVersionById(auth.client, submission.template_version_id);
        const templateRows = await pgSelect(auth.client, "report_templates", {
          filters: { id: submission.template_id },
          select: "id,name,code",
          limit: 1
        });
        const template = (templateRows ?? [])[0] ?? null;
        const attachments = await pgSelect(auth.client, "report_submission_attachments", {
          filters: { submission_id: submission.id },
          select: ATTACHMENT_COLUMNS,
          order: "created_at.asc"
        });

        // DR-24: when this row has ITSELF been revised, look up its
        // successor (revision_of = this row's id) so the UI can render "see
        // the revised version" without a second round trip. Only ever
        // queried for a 'revised' row -- every other status has no
        // successor by construction (revision_of is set exactly once, at
        // the moment revise mints the successor).
        let successorId = null;
        if (submission.status === "revised") {
          const successorRows = await pgSelect(auth.client, "report_submissions", {
            filters: { revision_of: submission.id },
            select: "id",
            limit: 1
          });
          successorId = (successorRows ?? [])[0]?.id ?? null;
        }

        // WO-21: pending/failed counts across this submission's own
        // report_workflow_events ledger (DR-19, 0053) -- lets the review UI
        // surface "a workflow-minted work order/incident is still queued" or
        // "one failed and needs attention" without exposing the raw ledger
        // rows. 'processing' counts as pending (mid-flight, not yet a
        // terminal outcome); 'skipped'/'processed' never contributed to
        // either counter (both are terminal, non-failing outcomes).
        const workflowEventRows = await pgSelect(auth.client, "report_workflow_events", {
          filters: { submission_id: submission.id, status: { in: ["pending", "processing", "failed"] } },
          select: "status"
        });
        const workflow = { pending: 0, failed: 0 };
        for (const row of workflowEventRows ?? []) {
          if (row.status === "failed") workflow.failed += 1;
          else workflow.pending += 1;
        }

        return sendJson(response, 200, {
          submission,
          schema_json: version?.schema_json ?? null,
          template_name: template?.name ?? null,
          attachments: attachments ?? [],
          // DR-17: lets the fill/review UI know which roles it should offer
          // "Sign as <role>" buttons for, without a second round trip just
          // to read the pinned version's validation_json.
          signature_requirements: version?.validation_json?.signature_requirements ?? null,
          successorId,
          workflow
        });
      })
  );

  // Creates a draft submission. Required fields (templateId, reportDate) are
  // shape-checked before anything else; the answer payload, if any, is
  // partially validated against the resolved active version's schema —
  // fields the caller hasn't answered yet are fine on a draft, but whatever
  // is supplied must satisfy that field's rules and must be a key the pinned
  // schema actually declares. Full (all-fields-required) validation is
  // enforced only when the draft is submitted.
  router.register(
    "POST",
    "/facilities/:facilityId/reports",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const { templateId, reportDate } = body.payload;
        const shape = [];
        if (!templateId) shape.push("templateId is required");
        if (!reportDate || !DATE_PATTERN.test(String(reportDate))) {
          shape.push("reportDate is required (YYYY-MM-DD)");
        }
        if (shape.length > 0) return sendJson(response, 400, { errors: shape });
        // Coarse pre-fetch gate (DR-11): a caller without reports.create via
        // ANY membership in this facility never reaches the template lookup.
        // The precise, department-scoped decision (mirroring 0033's INSERT
        // policy) happens below once the template's department_id is known.
        if (!requireAnyPermission(auth, params.facilityId, CREATE, response)) return;

        const template = await loadTemplate(auth.client, params.facilityId, templateId);
        if (!template) return sendJson(response, 404, { error: "report template not found" });
        if (!requireRowDeptPermission(auth, params.facilityId, template.department_id, CREATE, response)) return;
        if (template.status !== "published") {
          return sendJson(response, 409, { error: "report template is not published" });
        }
        const active = await loadActiveVersion(auth.client, template);
        if (!active) return sendJson(response, 409, { error: "report template has no published version" });

        const payload = body.payload.payload ?? {};
        const unknownKeys = unknownKeysError(active.schema, payload);
        if (unknownKeys) return sendJson(response, 422, unknownKeys);
        const partialErrors = validateReportSubmissionPartial(active.schema, payload);
        if (partialErrors.length > 0) return sendJson(response, 422, { errors: partialErrors });

        const row = {
          facility_id: params.facilityId,
          department_id: template.department_id ?? null,
          template_id: template.id,
          template_version_id: active.version.id,
          report_date: reportDate,
          shift_ref: body.payload.shiftRef ?? null,
          status: "draft",
          payload_json: payload,
          // source is always server-set to "web" for this route — a
          // client-sent `source` in the body is ignored, never trusted.
          source: "web"
        };
        const rows = await pgInsert(auth.client, "report_submissions", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  // Edits a draft submission's payload/shift in place. Non-drafts are immutable
  // (409); the guard runs on the loaded row's facility. When a payload is
  // supplied it is validated the same way create validates one: partially,
  // and only against keys the pinned version's schema actually declares.
  router.register("PATCH", "/reports/:id", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission) return sendJson(response, 404, { error: "report not found" });
      // Department-scoped (DR-11): mirrors 0033's UPDATE policy, keyed off
      // this submission's own department_id.
      if (!requireRowDeptPermission(auth, submission.facility_id, submission.department_id, SUBMIT, response)) {
        return;
      }
      if (submission.status !== "draft") {
        return sendJson(response, 409, { error: "only draft reports can be edited" });
      }
      if (body.payload.payload !== undefined) {
        const version = await loadVersionById(auth.client, submission.template_version_id);
        if (!version) return sendJson(response, 409, { error: "template version not found" });
        const unknownKeys = unknownKeysError(version.schema_json, body.payload.payload);
        if (unknownKeys) return sendJson(response, 422, unknownKeys);
        const partialErrors = validateReportSubmissionPartial(version.schema_json, body.payload.payload);
        if (partialErrors.length > 0) return sendJson(response, 422, { errors: partialErrors });
      }
      const patch = {};
      if (body.payload.payload !== undefined) patch.payload_json = body.payload.payload;
      if (body.payload.shiftRef !== undefined) patch.shift_ref = body.payload.shiftRef;
      if (Object.keys(patch).length === 0) {
        return sendJson(response, 400, { error: "nothing to update (send payload and/or shiftRef)" });
      }
      patch.updated_at = new Date().toISOString();
      const rows = await pgUpdate(auth.client, "report_submissions", { id: params.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // Finalizes a draft: verifies the pinned version still belongs to the
  // submission's template, rejects unknown payload keys, then validates the
  // full payload against the pinned version's schema. How validation errors
  // are handled depends on the pinned version's validation_json.submit_policy:
  //   - 'strict_block' (default, and anything unrecognized): errors block the
  //     submit with 422, exactly as before.
  //   - 'warn_and_submit': errors are downgraded to warnings and the submit
  //     proceeds, but only if the caller supplies a non-empty `reason` in the
  //     body (422 without one); {warnings, reason} is persisted onto
  //     validation_results.
  // Only drafts can be submitted; after this the row is immutable.
  router.register("POST", "/reports/:id/submit", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const body = await parseJsonBody(request);
      if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission) return sendJson(response, 404, { error: "report not found" });
      // Department-scoped (DR-11): mirrors 0033's UPDATE policy, keyed off
      // this submission's own department_id.
      if (!requireRowDeptPermission(auth, submission.facility_id, submission.department_id, SUBMIT, response)) {
        return;
      }
      if (submission.status !== "draft") {
        return sendJson(response, 409, { error: "only draft reports can be submitted" });
      }

      const version = await loadVersionById(auth.client, submission.template_version_id);
      if (!version) return sendJson(response, 409, { error: "template version not found" });
      if (version.template_id !== submission.template_id) {
        return sendJson(response, 409, {
          error: "pinned template version no longer belongs to this submission's template"
        });
      }

      const payload = submission.payload_json ?? {};
      const unknownKeys = unknownKeysError(version.schema_json, payload);
      if (unknownKeys) return sendJson(response, 422, unknownKeys);

      // M-2 (security review): signature_hash bound the payload at signing
      // time but nothing ever recomputed it -- a signer could sign a draft,
      // the draft's payload_json could then be PATCHed (still legal: still
      // draft, still reports.submit), and submit would succeed carrying a
      // signature that attests to content the signer never saw. Every
      // existing signature's hash is now re-derived against the CURRENT
      // payload right here, before either the completeness check or field
      // validation runs; any mismatch blocks the submit outright (409, not
      // 422 -- this is a precondition on the submission's signatures, not a
      // payload-shape error) rather than merely being recorded.
      const signatures = await pgSelect(auth.client, "report_submission_signatures", {
        filters: { submission_id: submission.id },
        select: "signer_user_id,signer_role,signature_hash"
      });
      const staleRoles = (signatures ?? [])
        .filter(
          (row) =>
            row.signature_hash !==
            signatureHash({ submissionId: submission.id, userId: row.signer_user_id, role: row.signer_role, payload })
        )
        .map((row) => row.signer_role);
      if (staleRoles.length > 0) {
        return sendJson(response, 409, { error: "signatures are stale", staleRoles });
      }

      // DR-17 submit-time completeness: when the pinned version requires
      // signatures, every listed role must already have a
      // report_submission_signatures row for this submission (recorded via
      // POST .../signatures, only ever reachable while the submission is
      // still a draft -- see 0052's trigger). Checked BEFORE field
      // validation so a caller sees exactly what's missing (signatures)
      // rather than a mix of concerns; 400, not 422, since this is a
      // precondition on the submission as a whole, not a per-field payload
      // error. M-3: signature_requirements.roles entries are { role,
      // permission } (or a bare string, normalized) -- only the role LABEL
      // matters for this completeness check; the permission is enforced at
      // sign time (POST .../signatures below), not here.
      const signatureRequirements = version.validation_json?.signature_requirements;
      if (signatureRequirements?.required === true) {
        const requiredRoles = Array.isArray(signatureRequirements.roles)
          ? signatureRequirements.roles.map(normalizeSignatureRoleRequirement).filter(Boolean).map((entry) => entry.role)
          : [];
        const signedRoles = new Set((signatures ?? []).map((row) => row.signer_role));
        const missingRoles = requiredRoles.filter((role) => !signedRoles.has(role));
        if (missingRoles.length > 0) {
          return sendJson(response, 400, { error: "missing required signatures", missingRoles });
        }
      }

      const errors = validateReportSubmission(version.schema_json, payload);
      const submitPolicy =
        version.validation_json?.submit_policy === "warn_and_submit" ? "warn_and_submit" : DEFAULT_SUBMIT_POLICY;
      // DR-16: fields hidden by their own visibility_rules at submit time are
      // recorded on validation_results for auditability, independent of
      // whether there are any other warnings -- see report-schema.mjs's
      // evaluateVisibility/hiddenFieldKeys.
      const hiddenFields = hiddenFieldKeys(version.schema_json, payload);
      // L-3: a value submitted for a field hidden by its own visibility_rules
      // was persisted with no type/range/regex check at all (it is never
      // required, and collectSubmissionErrors skips validating it
      // unconditionally) -- stripped out of what actually gets persisted at
      // submit time, so payload_json can never carry a value nothing has
      // ever validated. hiddenFields (above) still records which keys were
      // hidden, independent of this.
      const strippedPayload = stripHiddenFields(version.schema_json, payload);

      const patch = {
        status: "submitted",
        submitted_by: auth.claims.sub,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payload_json: strippedPayload
      };

      if (errors.length > 0) {
        if (submitPolicy !== "warn_and_submit") {
          return sendJson(response, 422, { errors });
        }
        const reason = typeof body.payload.reason === "string" ? body.payload.reason.trim() : "";
        if (!reason) {
          return sendJson(response, 422, {
            error: "reason is required to submit with validation warnings under warn_and_submit"
          });
        }
        patch.validation_results = { warnings: errors, reason, hidden_fields: hiddenFields };
      } else if (hiddenFields.length > 0) {
        patch.validation_results = { hidden_fields: hiddenFields };
      }

      const rows = await pgUpdate(auth.client, "report_submissions", { id: params.id }, patch, {
        returning: true
      });
      const submitted = (rows ?? [])[0] ?? null;

      // DR-18/DR-19/H-1: enqueue exactly one 'evaluate' workflow event
      // through internal.enqueue_report_workflow (0053) -- ALWAYS attempted
      // on a successful submit, so the outbox event fires uniformly; the
      // executor (running under the service-role client) is what actually
      // derives and persists the action list from the pinned version's
      // workflow_json. Wrapped end-to-end: a broken workflow rule, an RPC
      // rejection, or a network failure must NEVER turn a successful submit
      // into an error response -- the submission is already durably
      // 'submitted' by the pgUpdate above.
      await enqueueWorkflow(auth.client, { submission: submitted ?? submission });

      return sendJson(response, 200, submitted);
    })
  );

  // --- Signatures (DR-17/M-3) ---------------------------------------------
  // Signer is always the authenticated caller (never taken from the body);
  // signature_hash binds the submission id, signer, role, and a hash of the
  // payload at signing time, so a later payload edit is detectable against
  // an already-recorded signature. Only reachable while the submission is
  // still a draft (409 otherwise, backed at the DB layer by 0052's INSERT
  // trigger); the role must be one the pinned version's
  // validation_json.signature_requirements lists (400 otherwise).
  //
  // M-3 (security review): a signer_role label carried no permission of its
  // own, so any reports.submit holder could sign as every listed role in
  // sequence and single-handedly clear a multi-party sign-off gate. Each
  // roles[] entry now carries its own `permission`
  // (normalizeSignatureRoleRequirement, report-schema.mjs -- a bare string
  // entry still normalizes to reports.submit for backward compatibility);
  // this route requires the caller to hold THAT permission on the
  // submission's own facility/department (department-scoped, same
  // hasDepartmentPermission check every other row guard here uses) before
  // the signature is recorded, so a role requiring e.g. reports.publish can
  // only ever be signed by someone who actually holds it.
  router.register(
    "POST",
    "/facilities/:facilityId/reports/:id/signatures",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const body = await parseJsonBody(request);
        if (!body.ok) return sendJson(response, 400, { error: "invalid JSON body" });
        const role = typeof body.payload.role === "string" ? body.payload.role.trim() : "";
        if (!role) return sendJson(response, 400, { errors: ["role is required"] });

        const submission = await loadSubmission(auth.client, params.id);
        if (!submission || submission.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "report not found" });
        }
        // Department-scoped (DR-11): mirrors PATCH/submit's own gate.
        if (!requireRowDeptPermission(auth, submission.facility_id, submission.department_id, SUBMIT, response)) {
          return;
        }
        if (submission.status !== "draft") {
          return sendJson(response, 409, { error: "only a draft report can be signed" });
        }

        const version = await loadVersionById(auth.client, submission.template_version_id);
        if (!version) return sendJson(response, 409, { error: "template version not found" });
        const allowedRoleEntries = Array.isArray(version.validation_json?.signature_requirements?.roles)
          ? version.validation_json.signature_requirements.roles.map(normalizeSignatureRoleRequirement).filter(Boolean)
          : [];
        const matched = allowedRoleEntries.find((entry) => entry.role === role);
        if (!matched) {
          return sendJson(response, 400, {
            error: `role "${role}" is not a listed signature role for this template`
          });
        }
        // M-3: holding reports.submit (checked above) is not enough on its
        // own -- the caller must additionally hold the role's OWN mapped
        // permission on this submission's facility/department.
        if (!requireRowDeptPermission(auth, submission.facility_id, submission.department_id, matched.permission, response)) {
          return;
        }

        const row = {
          facility_id: submission.facility_id,
          submission_id: submission.id,
          signer_user_id: auth.claims.sub,
          signer_role: role,
          signature_hash: signatureHash({
            submissionId: submission.id,
            userId: auth.claims.sub,
            role,
            payload: submission.payload_json
          })
        };
        const rows = await pgInsert(auth.client, "report_submission_signatures", [row], { returning: true });
        return sendJson(response, 201, (rows ?? [])[0] ?? null);
      })
  );

  router.register(
    "GET",
    "/facilities/:facilityId/reports/:id/signatures",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        const submission = await loadSubmission(auth.client, params.id);
        if (!submission || submission.facility_id !== params.facilityId) {
          return sendJson(response, 404, { error: "report not found" });
        }
        if (!requireRead(auth, submission.facility_id, response)) return;
        const rows = await pgSelect(auth.client, "report_submission_signatures", {
          filters: { submission_id: submission.id },
          select: SIGNATURE_COLUMNS,
          order: "signed_at.asc"
        });
        return sendJson(response, 200, rows ?? []);
      })
  );

  // --- Lock / Revise (DR-24) ---------------------------------------------
  // POST /facilities/:facilityId/reports/:id/lock : submitted -> locked.
  // Gated on reports.publish (department-scoped, same shape as every other
  // row guard here) -- see the PUBLISH constant's comment above for why this
  // reuses that code instead of a new one. 0055's RLS policy + transition
  // trigger enforce the identical rule at the DB layer independent of this
  // check, so a direct PostgREST call cannot bypass it either.
  router.register("POST", "/facilities/:facilityId/reports/:id/lock", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission || submission.facility_id !== params.facilityId) {
        return sendJson(response, 404, { error: "report not found" });
      }
      if (!requireRowDeptPermission(auth, submission.facility_id, submission.department_id, PUBLISH, response)) {
        return;
      }
      if (submission.status !== "submitted") {
        return sendJson(response, 409, { error: "only a submitted report can be locked" });
      }
      const patch = { status: "locked", updated_at: new Date().toISOString() };
      const rows = await pgUpdate(auth.client, "report_submissions", { id: params.id }, patch, { returning: true });
      return sendJson(response, 200, (rows ?? [])[0] ?? null);
    })
  );

  // POST /facilities/:facilityId/reports/:id/revise : submitted|locked ->
  // revised. The original row becomes immutable (0055's transition trigger
  // rejects any further change to a 'revised' row); a NEW draft successor is
  // minted with revision_of pointing back at the original, copying
  // payload_json and template_version_id (and department_id/report_date/
  // shift_ref) forward as the starting point for the correction. Same
  // reports.publish guard as lock, for the same reason.
  //
  // Ordering: the successor is inserted BEFORE the original is flipped to
  // 'revised'. These are two separate, non-transactional PostgREST calls (no
  // multi-statement RPC exists for this, matching every other multi-write
  // route in this file, e.g. the template-publish route's sequential version
  // + template PATCHes) -- inserting first means a failure on the second
  // write leaves an orphaned draft rather than an original stuck 'revised'
  // with no successor to continue from, which is the safer failure mode of
  // the two.
  router.register("POST", "/facilities/:facilityId/reports/:id/revise", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission || submission.facility_id !== params.facilityId) {
        return sendJson(response, 404, { error: "report not found" });
      }
      if (!requireRowDeptPermission(auth, submission.facility_id, submission.department_id, PUBLISH, response)) {
        return;
      }
      if (submission.status !== "submitted" && submission.status !== "locked") {
        return sendJson(response, 409, { error: "only a submitted or locked report can be revised" });
      }

      const successorRow = {
        facility_id: submission.facility_id,
        department_id: submission.department_id ?? null,
        template_id: submission.template_id,
        template_version_id: submission.template_version_id,
        report_date: submission.report_date,
        shift_ref: submission.shift_ref,
        status: "draft",
        payload_json: submission.payload_json ?? {},
        revision_of: submission.id,
        source: "web"
      };
      const successorRows = await pgInsert(auth.client, "report_submissions", [successorRow], { returning: true });
      const successor = (successorRows ?? [])[0] ?? null;
      if (!successor) return sendJson(response, 500, { error: "failed to create revision successor" });

      const patch = { status: "revised", updated_at: new Date().toISOString() };
      const revisedRows = await pgUpdate(auth.client, "report_submissions", { id: params.id }, patch, {
        returning: true
      });
      return sendJson(response, 200, { original: (revisedRows ?? [])[0] ?? null, successor });
    })
  );

  // --- PDF snapshot (DR-23) -----------------------------------------------
  // GET /facilities/:facilityId/reports/:id/pdf : signed URL onto the
  // immutable snapshot the async drain (report-pdf-worker.mjs) already
  // rendered and uploaded -- distinct from GET /reports/:id/pdf above
  // (DR-15), which re-renders a fresh, non-archival PDF from whatever is
  // live right now. Gated on reports.export, matching DR-15's existing
  // "PDF access" permission convention on this same surface (not a new
  // reports.read-only surface: pulling a signed URL onto a document is the
  // same class of action as generating one on demand). 404 while the
  // snapshot has not been generated yet -- not 409 -- so a caller polling
  // for it can't distinguish "still queued" from "will never exist" any
  // more precisely than the pdf_status field on the submission itself
  // already tells them.
  router.register("GET", "/facilities/:facilityId/reports/:id/pdf", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission || submission.facility_id !== params.facilityId) {
        return sendJson(response, 404, { error: "report not found" });
      }
      if (!requirePerm(auth, params.facilityId, EXPORT, response)) return;
      if (submission.pdf_status !== "generated" || !submission.pdf_storage_path) {
        return sendJson(response, 404, { error: "pdf snapshot not yet generated" });
      }

      // Defense-in-depth twin of 0055's pdf_storage_path shape CHECK: never
      // mint a signed URL for a path that disagrees with this row's own
      // facility -- same posture as attachments-routes.mjs/
      // training-routes.mjs's identical guard.
      try {
        assertPathInFacility(submission.pdf_storage_path, params.facilityId, "reports");
      } catch (error) {
        if (error instanceof StorageValidationError) {
          return sendJson(response, 404, { error: "report not found" });
        }
        throw error;
      }

      const storageClient = createStorageClientFromEnv(env);
      try {
        const url = await createSignedUrl(storageClient, submission.pdf_storage_path, SNAPSHOT_SIGNED_URL_TTL_SECONDS);
        return sendJson(response, 200, { url, expiresInSeconds: SNAPSHOT_SIGNED_URL_TTL_SECONDS });
      } catch {
        return sendJson(response, 502, { error: "failed to create signed url" });
      }
    })
  );

  // --- Compliance (DR-12) -----------------------------------------------
  // GET /facilities/:facilityId/reports/compliance?from=&to= : per published
  // template per date in [from, to], {expected, submitted, missing,
  // overdue}. Read-guarded (facility-wide reports.read -- the
  // report_submissions SELECT policy this reads through was NOT changed by
  // 0033, so this stays facility-wide too, matching "facility-wide members
  // unaffected"). See reports-compliance.mjs for the pure computation and
  // its documented UTC timezone basis.
  const MAX_COMPLIANCE_DAYS = 366;
  router.register(
    "GET",
    "/facilities/:facilityId/reports/compliance",
    (request, response, { env, params }) =>
      withAuth(request, response, env, async (auth) => {
        if (!requireRead(auth, params.facilityId, response)) return;
        const qp = queryParams(request);
        const from = qp.get("from");
        const to = qp.get("to");
        if (!from || !DATE_PATTERN.test(from)) {
          return sendJson(response, 400, { error: "from is required (YYYY-MM-DD)" });
        }
        if (!to || !DATE_PATTERN.test(to)) {
          return sendJson(response, 400, { error: "to is required (YYYY-MM-DD)" });
        }
        if (to < from) return sendJson(response, 400, { error: "to must not be before from" });
        if (dateRange(from, to).length > MAX_COMPLIANCE_DAYS) {
          return sendJson(response, 400, { error: `date range too large (max ${MAX_COMPLIANCE_DAYS} days)` });
        }

        const [templates, submissions, config] = await Promise.all([
          pgSelect(auth.client, "report_templates", {
            filters: { facility_id: params.facilityId, status: "published" },
            select: "id,code,name,department_id,status,created_at"
          }),
          pgSelect(auth.client, "report_submissions", {
            filters: { facility_id: params.facilityId, report_date: { gte: from, lte: to } },
            select: "template_id,report_date,status"
          }),
          loadModuleConfig({ client: auth.client, facilityId: params.facilityId, moduleCode: "daily_reports" })
        ]);

        const result = computeCompliance({
          templates: templates ?? [],
          submissions: submissions ?? [],
          from,
          to,
          config
        });
        return sendJson(response, 200, result);
      })
  );

  // --- PDF export (DR-15) -------------------------------------------------
  // GET /reports/:id/pdf : renders the PINNED version's schema + payload as a
  // sectioned Q/A PDF (report-pdf.mjs), gated on BOTH reports.export (facility
  // scope -- matches 0021's reports.export read regression, unchanged by
  // 0033) AND the reports.pdf_export feature flag (0018; percentage rollout,
  // default_state false -- see supabase/seed.sql:317, no rule seeded, so this
  // is closed by default until a facility/org rule turns it on). Draft
  // submissions have nothing pinned to render meaningfully yet, so 409.
  router.register("GET", "/reports/:id/pdf", (request, response, { env, params }) =>
    withAuth(request, response, env, async (auth) => {
      const submission = await loadSubmission(auth.client, params.id);
      if (!submission) return sendJson(response, 404, { error: "report not found" });
      if (!requirePerm(auth, submission.facility_id, EXPORT, response)) return;
      if (submission.status === "draft") {
        return sendJson(response, 409, { error: "draft reports cannot be exported to PDF" });
      }

      const facilityRows = await pgSelect(auth.client, "facilities", {
        filters: { id: submission.facility_id },
        select: "id,name,organization_id",
        limit: 1
      });
      const facility = (facilityRows ?? [])[0] ?? null;
      if (!facility) return sendJson(response, 404, { error: "facility not found" });

      const [flags, rules] = await Promise.all([
        pgSelect(auth.client, "feature_flags", {
          filters: { key: PDF_EXPORT_FLAG },
          select: "id,key,description,rollout_type,default_state",
          limit: 1
        }),
        pgSelect(auth.client, "feature_flag_rules", {
          select: "id,feature_flag_id,scope_type,scope_id,state,rollout_percentage,starts_at,ends_at"
        })
      ]);
      const flag = (flags ?? [])[0] ?? null;
      const flagRules = (rules ?? []).filter((rule) => rule.feature_flag_id === flag?.id);
      const enabled = flagState(flag, flagRules, {
        organizationId: facility.organization_id,
        facilityId: submission.facility_id,
        bucket: 0,
        now: new Date()
      });
      if (!enabled) {
        return sendJson(response, 403, { error: `feature not enabled: ${PDF_EXPORT_FLAG}` });
      }

      // Pinned version, not the template's current active version -- a
      // re-publish after this submission was filed must not relabel it.
      const version = await loadVersionById(auth.client, submission.template_version_id);
      if (!version) return sendJson(response, 409, { error: "template version not found" });

      const templateRows = await pgSelect(auth.client, "report_templates", {
        filters: { id: submission.template_id },
        select: "id,name,code",
        limit: 1
      });
      const template = (templateRows ?? [])[0] ?? null;

      let departmentName = null;
      if (submission.department_id) {
        const deptRows = await pgSelect(auth.client, "departments", {
          filters: { id: submission.department_id },
          select: "id,name",
          limit: 1
        });
        departmentName = (deptRows ?? [])[0]?.name ?? null;
      }

      let submitterName = null;
      if (submission.submitted_by) {
        const userRows = await pgSelect(auth.client, "app_users", {
          filters: { id: submission.submitted_by },
          select: "id,full_name",
          limit: 1
        });
        submitterName = (userRows ?? [])[0]?.full_name ?? null;
      }

      const pkg = buildReportPdfPackage({
        submissionId: submission.id,
        facilityName: facility.name,
        departmentName,
        templateName: template?.name ?? null,
        templateCode: template?.code ?? null,
        reportDate: submission.report_date,
        shiftRef: submission.shift_ref,
        status: submission.status,
        schema: version.schema_json,
        payload: submission.payload_json ?? {},
        submitterName,
        submittedAt: submission.submitted_at,
        // DR-24 landed report_submissions.revision_of: a row born as a
        // revision successor shows which original it continues from; a row
        // that has ITSELF since been revised (status = 'revised') still
        // reads "Revised" -- distinguishing the two matters more than
        // reusing one label for both.
        revisionMarker: submission.status === "revised" ? "Revised" : submission.revision_of ? `Revision of ${submission.revision_of}` : "Original"
      });

      return sendJson(response, 200, {
        ...pkg,
        contentDisposition: `attachment; filename="${pkg.filename}"`
      });
    })
  );

  return router;
}
