// DR-18 -- pure report submission workflow rule engine. Reads a template
// version's `workflow_json` and a submission's payload and produces an
// ORDERED list of actions for DR-19 to persist as report_workflow_events
// rows and DR-20 to execute in the drain. No I/O here -- exactly like
// report-schema.mjs and incidents.mjs/work-orders.mjs, this module only
// transforms data the caller already loaded.
//
// Supported `workflow_json` shapes (both keyed at `on_submit`):
//   1. String-array (the seeded shape, supabase/seed.sql:157):
//        { "on_submit": ["queue_pdf", "notify_managers"] }
//      Each string maps 1:1 to an action with no conditions and default
//      params: "queue_pdf" -> {type:"queue_pdf"}, "notify_managers" ->
//      {type:"notify", params:{target:"managers"}}. Any other string is an
//      unknown action -- recorded as a warning, never thrown.
//   2. Object-array (richer authoring shape):
//        { "on_submit": [
//            { "type": "create_incident", "params": {...}, "when": [
//              { "field": "pool_ready", "op": "eq", "value": "fail" }
//            ] }
//        ] }
//      `type` must be one of the four known action types. `when` is an
//      optional list of conditions evaluated against the submitted
//      `payload`, ALL of which must hold (AND) for the action to fire; an
//      absent/empty `when` always fires. Supported operators mirror the
//      report-schema.mjs field-visibility op set: eq, neq, in, gt, lt.
//
// Malformed rules (not an object, missing/invalid `type`, an unparseable
// `when` entry, an `in` operand that isn't an array, a non-numeric operand
// for gt/lt) are skipped with a warning -- this function NEVER throws on bad
// template authoring, since a broken workflow rule must never block a report
// submission (reports-routes.mjs wraps this in try/catch anyway, but the
// contract holds independent of that).
import { shouldEscalateIncident, classifyOshaReview } from "./incidents.mjs";
import { slaHoursForPriority, WORK_ORDER_PRIORITIES } from "./work-orders.mjs";
import { configValue } from "./settings-registry.mjs";
import { extractDefects } from "./report-schema.mjs";

const ACTION_TYPES = new Set(["create_incident", "create_work_order", "notify", "queue_pdf"]);
const CONDITION_OPS = new Set(["eq", "neq", "in", "gt", "lt"]);
const INCIDENT_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const INCIDENT_REPORT_TYPES = new Set(["incident", "accident", "near_miss"]);
const WORK_ORDER_PRIORITY_SET = new Set(WORK_ORDER_PRIORITIES);

// The seeded string-array shape's fixed action vocabulary.
const STRING_ACTION_MAP = {
  queue_pdf: () => ({ type: "queue_pdf", params: {} }),
  notify_managers: () => ({ type: "notify", params: { target: "managers", message: null } })
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Evaluates one { field, op, value } condition against `payload`. Returns
// `{ ok: true, result: boolean }` on a well-formed condition or
// `{ ok: false }` when the condition itself is malformed (unknown op,
// missing field, non-array `in` operand, non-numeric gt/lt operand) -- the
// caller treats `ok: false` as "this rule cannot be evaluated" and skips the
// whole action with a warning rather than guessing at a truth value.
function evaluateCondition(condition, payload) {
  if (!isPlainObject(condition) || typeof condition.field !== "string" || condition.field.length === 0) {
    return { ok: false };
  }
  if (!CONDITION_OPS.has(condition.op)) return { ok: false };
  const actual = payload?.[condition.field];

  switch (condition.op) {
    case "eq":
      return { ok: true, result: actual === condition.value };
    case "neq":
      return { ok: true, result: actual !== condition.value };
    case "in":
      if (!Array.isArray(condition.value)) return { ok: false };
      return { ok: true, result: condition.value.includes(actual) };
    case "gt":
    case "lt": {
      const left = Number(actual);
      const right = Number(condition.value);
      if (Number.isNaN(left) || Number.isNaN(right)) return { ok: false };
      return { ok: true, result: condition.op === "gt" ? left > right : left < right };
    }
    default:
      return { ok: false };
  }
}

// Evaluates a `when` array as an AND of every condition. Returns
// `{ ok: true, matched: boolean }` or `{ ok: false }` (any condition
// malformed -> the whole rule is unevaluable). An absent/empty `when` always
// matches.
function evaluateWhen(when, payload) {
  if (when === undefined || when === null) return { ok: true, matched: true };
  if (!Array.isArray(when)) return { ok: false };
  for (const condition of when) {
    const evaluated = evaluateCondition(condition, payload);
    if (!evaluated.ok) return { ok: false };
    if (!evaluated.result) return { ok: true, matched: false };
  }
  return { ok: true, matched: true };
}

// create_incident params: severity/reportType are taken from the rule's own
// params (validated against the DB check-constraint vocabularies,
// 0004_incidents.sql), falling back to safe defaults. requiresOshaReview is
// derived through incidents.mjs's classifyOshaReview when the rule doesn't
// set it explicitly, and `escalate` is a hint (not itself an action --
// DR-20 always mints the incident as `draft`) computed through
// shouldEscalateIncident so a downstream reader can see whether this
// workflow-minted incident would also qualify for auto-escalation under the
// facility's own incidents.* settings.
function buildIncidentParams(rawParams, { payload, config }) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  const severity = INCIDENT_SEVERITIES.has(params.severity) ? params.severity : "medium";
  const reportType = INCIDENT_REPORT_TYPES.has(params.reportType) ? params.reportType : "incident";
  const outcomes = Array.isArray(params.outcomes) ? params.outcomes : [];
  const requiresOshaReview =
    params.requiresOshaReview === true || classifyOshaReview(reportType, outcomes);
  const escalate = shouldEscalateIncident({ severity, legalHold: false, requiresOshaReview }, config);
  const summary = typeof params.summary === "string" && params.summary.trim() ? params.summary.trim() : null;
  const locationText =
    typeof params.locationText === "string" && params.locationText.trim() ? params.locationText.trim() : null;
  return { severity, reportType, requiresOshaReview, escalate, summary, locationText, sourcePayload: payload ?? {} };
}

// create_work_order params: priority is either explicitly set (validated
// against work-orders.mjs's own WORK_ORDER_PRIORITIES) or derived from the
// rule's severity using the same mapping createWorkOrderFromIncident uses
// (critical -> urgent, high -> high, else the facility's configured
// default); slaHours/dueAt are derived through work-orders.mjs's
// slaHoursForPriority so this stays the single source of truth for SLA math.
function buildWorkOrderParams(rawParams, { config, now }) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  const severity = INCIDENT_SEVERITIES.has(params.severity) ? params.severity : null;
  const fallbackPriority = configValue(config, "workOrders.defaultPriority");
  const derivedPriority =
    severity === "critical" ? "urgent" : severity === "high" ? "high" : fallbackPriority;
  const priority = WORK_ORDER_PRIORITY_SET.has(params.priority) ? params.priority : derivedPriority;
  const slaHours = slaHoursForPriority(priority, config);
  const dueAt = new Date(now.getTime() + slaHours * 60 * 60 * 1000).toISOString();
  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : null;
  const description =
    typeof params.description === "string" && params.description.trim() ? params.description.trim() : null;
  return { priority, slaHours, dueAt, title, description };
}

// WO-21: one create_work_order action per extracted defect (report-schema.mjs
// extractDefects), gated on the work_orders.autoCreateFromReportDefects
// setting (new settings-registry key, default false). Priority/SLA are
// derived exactly like a rule-authored create_work_order action with no
// explicit severity/priority -- the facility's configured default priority,
// through the same slaHoursForPriority math -- since a defect field carries
// no severity signal of its own beyond "this fired".
//
// `eventType` is set to `create_work_order:<fieldKey>` rather than the
// default `<type>:<index>` composition: 0060's create-or-replace of
// internal.enqueue_report_workflow (0053) honors an action's own eventType
// when present (falling back to type:index otherwise), so each defect's
// report_workflow_events ledger row is labeled by the field that produced
// it -- and, since report_workflow_events' own uniqueness is
// (submission_id, event_type), this is also what keeps two DIFFERENT
// defects on the same submission from colliding into a single ledger row.
// `params.sourceDefectKey` carries the same field key through to
// internal.mint_workflow_work_order (0060), which is what keeps the DB-side
// idempotency guard per-defect rather than per-submission (see that
// migration's header for the full derivation).
function buildDefectWorkOrderAction(defect, { config, now }) {
  const priority = configValue(config, "workOrders.defaultPriority");
  const slaHours = slaHoursForPriority(priority, config);
  const dueAt = new Date(now.getTime() + slaHours * 60 * 60 * 1000).toISOString();
  return {
    type: "create_work_order",
    eventType: `create_work_order:${defect.fieldKey}`,
    params: {
      priority,
      slaHours,
      dueAt,
      title: `Defect: ${defect.label}`,
      description: defect.summary,
      sourceDefectKey: defect.fieldKey
    }
  };
}

function buildNotifyParams(rawParams) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  const target = typeof params.target === "string" && params.target.trim() ? params.target.trim() : "managers";
  const message = typeof params.message === "string" && params.message.trim() ? params.message.trim() : null;
  return { target, message };
}

// Builds the final action object for a known, matched rule, threading each
// type's derived params through its own builder above. `queue_pdf` carries
// no params at all.
function buildAction(type, rawParams, context) {
  switch (type) {
    case "create_incident":
      return { type, params: buildIncidentParams(rawParams, context) };
    case "create_work_order":
      return { type, params: buildWorkOrderParams(rawParams, context) };
    case "notify":
      return { type, params: buildNotifyParams(rawParams) };
    case "queue_pdf":
      return { type, params: {} };
    default:
      return null;
  }
}

// Normalizes workflow_json's `on_submit` into ordered { type, params, when }
// rule descriptors, handling both the string-array and object-array shapes.
// Never throws: an unrecognized top-level shape yields no rules (the caller
// sees this as "nothing to do", not an error -- an empty/missing
// workflow_json is the common case for most templates).
function normalizeRules(workflowJson) {
  const onSubmit = workflowJson?.on_submit;
  if (!Array.isArray(onSubmit)) return [];
  return onSubmit.map((entry) => {
    if (typeof entry === "string") {
      return { kind: "string", raw: entry };
    }
    if (isPlainObject(entry)) {
      return { kind: "object", raw: entry };
    }
    return { kind: "invalid", raw: entry };
  });
}

// evaluateWorkflow({ template, version, submission, payload, now, config })
// -> { actions: [{ type, params }], warnings: [string] }.
//
// `template`/`submission` are accepted for forward compatibility (a future
// rule vocabulary keyed on template metadata or submission fields beyond the
// payload) but only `version.workflow_json` and `payload` currently drive
// the result; `now` anchors work-order SLA math (defaults to `new Date()`);
// `config` is an optional flat settings map (settings-registry shape) fed
// through to incidents.mjs/work-orders.mjs helpers -- callers that have
// already resolved the facility's incidents.*/workOrders.* settings should
// pass it so severity auto-escalation and SLA hours reflect the facility's
// own configuration; omitted, every helper falls back to its own shipped
// default (configValue's documented behavior).
export function evaluateWorkflow({ template, version, submission, payload, now, config } = {}) {
  const actions = [];
  const warnings = [];
  const effectiveNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const effectivePayload = isPlainObject(payload) ? payload : {};
  const effectiveConfig = isPlainObject(config) ? config : {};
  const context = { template, submission, payload: effectivePayload, config: effectiveConfig, now: effectiveNow };

  const rules = normalizeRules(version?.workflow_json);
  for (const [index, rule] of rules.entries()) {
    if (rule.kind === "string") {
      const builder = STRING_ACTION_MAP[rule.raw];
      if (!builder) {
        warnings.push(`on_submit[${index}]: unknown workflow action "${rule.raw}"`);
        continue;
      }
      actions.push(builder());
      continue;
    }

    if (rule.kind !== "object") {
      warnings.push(`on_submit[${index}]: rule must be a string or an object`);
      continue;
    }

    const entry = rule.raw;
    if (!ACTION_TYPES.has(entry.type)) {
      warnings.push(`on_submit[${index}]: unknown or missing action type "${entry.type}"`);
      continue;
    }

    const when = evaluateWhen(entry.when, effectivePayload);
    if (!when.ok) {
      warnings.push(`on_submit[${index}]: malformed "when" condition, action skipped`);
      continue;
    }
    if (!when.matched) continue;

    const action = buildAction(entry.type, entry.params, context);
    if (!action) {
      warnings.push(`on_submit[${index}]: unable to build action for type "${entry.type}"`);
      continue;
    }
    actions.push(action);
  }

  // WO-21: one create_work_order action per report-schema.mjs defect field,
  // appended AFTER every rule-authored action (rule order above is
  // preserved unchanged; defects are a distinct, additive source of
  // actions, not interleaved with the template author's own on_submit
  // list). Off by default (configValue's shipped default is false) -- a
  // facility that has configured nothing sees byte-identical behavior to
  // before this existed.
  if (configValue(effectiveConfig, "workOrders.autoCreateFromReportDefects")) {
    const defects = extractDefects({ payload: effectivePayload }, version);
    for (const defect of defects) {
      actions.push(buildDefectWorkOrderAction(defect, context));
    }
  }

  return { actions, warnings };
}

// Exported for DR-19/H-1's event_type generation -- used directly by
// report-workflow-executor.mjs's executeEvaluate when it inserts each derived
// action's own report_workflow_events row (H-1 moved action derivation
// server-side into the executor; this is the single source of truth for the
// naming scheme -- the RPC itself only ever inserts one 'evaluate' event) --
// and by tests. An action carrying its own non-empty `eventType` (WO-21's
// per-defect create_work_order actions, `create_work_order:<fieldKey>`) uses
// it verbatim so two defects on one submission get two distinct ledger rows;
// every other action falls back to the `${type}:${index}` composition.
export function actionEventType(action, index) {
  const custom = typeof action?.eventType === "string" ? action.eventType.trim() : "";
  if (custom) return custom;
  return `${action?.type ?? "unknown"}:${index}`;
}

export { ACTION_TYPES as REPORT_WORKFLOW_ACTION_TYPES };
