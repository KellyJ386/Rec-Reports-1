import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRuleInput,
  validateRulePatch,
  dueAtForRule,
  selectRuleTargets,
  triggerState,
  resolveTriggerCourse
} from "../src/lib/training-rules.mjs";

const COURSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TYPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-07-06T12:00:00Z");

test("validateRuleInput: a certification rule needs a certification type and course", () => {
  assert.equal(validateRuleInput({ ruleType: "certification", certificationTypeId: TYPE, courseId: COURSE }).valid, true);
  assert.equal(
    validateRuleInput({ ruleType: "certification", certificationTypeId: TYPE, courseId: COURSE, roleId: ROLE, gapStatuses: ["missing"], dueDays: 14 }).valid,
    true
  );
  assert.equal(validateRuleInput({ ruleType: "certification", courseId: COURSE }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "certification", certificationTypeId: "nope", courseId: COURSE }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "certification", certificationTypeId: TYPE, courseId: COURSE, gapStatuses: [] }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "certification", certificationTypeId: TYPE, courseId: COURSE, gapStatuses: ["gone"] }).valid, false);
});

test("validateRuleInput: a role rule needs a role and may not carry certification fields", () => {
  assert.equal(validateRuleInput({ ruleType: "role", roleId: ROLE, courseId: COURSE }).valid, true);
  assert.equal(validateRuleInput({ ruleType: "role", courseId: COURSE }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "role", roleId: ROLE, courseId: COURSE, certificationTypeId: TYPE }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "role", roleId: ROLE, courseId: COURSE, gapStatuses: ["missing"] }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "other", roleId: ROLE, courseId: COURSE }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "role", roleId: ROLE, courseId: COURSE, dueDays: 0 }).valid, false);
  assert.equal(validateRuleInput({ ruleType: "role", roleId: ROLE, courseId: COURSE, dueDays: 366 }).valid, false);
});

test("validateRulePatch only accepts active / dueDays / gapStatuses", () => {
  assert.equal(validateRulePatch({ active: false }).valid, true);
  assert.equal(validateRulePatch({ dueDays: null }).valid, true);
  assert.equal(validateRulePatch({ gapStatuses: ["expired"] }).valid, true);
  assert.equal(validateRulePatch({ active: "no" }).valid, false);
  assert.equal(validateRulePatch({ gapStatuses: [] }).valid, false);
});

test("dueAtForRule prefers the rule's own due_days, else the facility default", () => {
  assert.equal(dueAtForRule({ due_days: 7 }, 30, NOW), "2026-07-13T12:00:00.000Z");
  assert.equal(dueAtForRule({ due_days: null }, 30, NOW), "2026-08-05T12:00:00.000Z");
});

const employees = [
  { id: "e-ok", facility_id: "fac-1" },
  { id: "e-gap", facility_id: "fac-1" },
  { id: "e-expiring", facility_id: "fac-1" },
  { id: "e-held", facility_id: "fac-1" },
  { id: "e-other-facility", facility_id: "fac-2" }
];
const certsByEmployee = {
  "e-gap": [{ certification_type_id: TYPE, expires_at: "2026-01-01", status: "active", renewal_window_days: 30 }],
  "e-expiring": [{ certification_type_id: TYPE, expires_at: "2026-07-20", status: "active", renewal_window_days: 30 }],
  "e-held": [{ certification_type_id: TYPE, expires_at: "2028-01-01", status: "active", renewal_window_days: 30 }],
  "e-other-facility": []
};

test("selectRuleTargets (role rule): every in-facility candidate, never another facility's employee", () => {
  const targets = selectRuleTargets({ rule_type: "role", facility_id: "fac-1", role_id: ROLE }, { candidates: employees });
  assert.deepEqual(targets.map((t) => t.employeeId), ["e-ok", "e-gap", "e-expiring", "e-held"]);
});

test("selectRuleTargets (certification rule): missing, expired and expiring gaps only, filtered by gap_statuses", () => {
  const rule = { rule_type: "certification", facility_id: "fac-1", certification_type_id: TYPE, gap_statuses: ["missing", "expired", "expiring"] };
  const all = selectRuleTargets(rule, { candidates: employees, certsByEmployee, now: NOW });
  assert.deepEqual(
    Object.fromEntries(all.map((t) => [t.employeeId, t.reason])),
    { "e-ok": "missing", "e-gap": "expired", "e-expiring": "expiring" }
  );
  const expiredOnly = selectRuleTargets({ ...rule, gap_statuses: ["expired"] }, { candidates: employees, certsByEmployee, now: NOW });
  assert.deepEqual(expiredOnly.map((t) => t.employeeId), ["e-gap"]);
  // an employee of another facility is dropped even though they "have a gap"
  assert.equal(all.some((t) => t.employeeId === "e-other-facility"), false);
});

test("triggerState: pending until a conversion or an incident_rule assignment exists", () => {
  const trigger = { id: "t1" };
  assert.deepEqual(triggerState(trigger, { conversionByTrigger: new Map(), assignmentByTrigger: new Map() }), {
    state: "pending",
    assignmentId: null
  });
  assert.deepEqual(
    triggerState(trigger, { conversionByTrigger: new Map([["t1", { assignment_id: "a1" }]]), assignmentByTrigger: new Map() }),
    { state: "assigned", assignmentId: "a1" }
  );
  assert.deepEqual(
    triggerState(trigger, { conversionByTrigger: new Map(), assignmentByTrigger: new Map([["t1", { id: "a2" }]]) }),
    { state: "assigned", assignmentId: "a2" }
  );
});

test("resolveTriggerCourse: module targets resolve through the module, certification targets need a course or a rule", () => {
  assert.deepEqual(resolveTriggerCourse({ target: { trainingModuleId: "m1" } }, { moduleCourseId: "c1" }), { courseId: "c1" });
  assert.match(resolveTriggerCourse({ target: { trainingModuleId: "m1" } }, {}).error, /no longer exists/);
  const certTrigger = { target: { certificationTypeId: TYPE } };
  assert.deepEqual(resolveTriggerCourse(certTrigger, { courseId: "c2" }), { courseId: "c2" });
  assert.deepEqual(
    resolveTriggerCourse(certTrigger, {
      certificationRules: [
        { rule_type: "certification", certification_type_id: "other", course_id: "x" },
        { rule_type: "certification", certification_type_id: TYPE, course_id: "c3" }
      ]
    }),
    { courseId: "c3" }
  );
  assert.match(resolveTriggerCourse(certTrigger, {}).error, /no course is linked/);
  assert.match(resolveTriggerCourse({ target: {} }, {}).error, /neither/);
});
