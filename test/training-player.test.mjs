import test from "node:test";
import assert from "node:assert/strict";
import {
  nextModuleToResume,
  moduleStatusLabel,
  courseProgressSummary,
  canMarkModuleComplete,
  canStartQuiz,
  safeExternalUrl,
  checklistItems,
  buildAnswersPayload,
  validateQuizSelections,
  quizResultMessage,
  quizStatusLine,
  dueLabel,
  assignmentSourceLabel,
  describeTriggerTarget,
  triggerNeedsCoursePick,
  buildAssignTriggerPayload
} from "../src/public/js/training-player.mjs";

const mod = (id, orderNo, state, extra = {}) => ({
  id,
  orderNo,
  required: true,
  moduleType: "video",
  progress: state ? { state, startedAt: state === "not_started" ? null : "2026-07-01T00:00:00Z" } : null,
  ...extra
});

test("nextModuleToResume: an in-progress module beats the first untouched one, completed modules are skipped", () => {
  assert.equal(nextModuleToResume([mod("a", 1, "completed"), mod("b", 2, null), mod("c", 3, "in_progress")]), "c");
  assert.equal(nextModuleToResume([mod("a", 1, "completed"), mod("b", 2, null), mod("c", 3, null)]), "b");
  assert.equal(nextModuleToResume([mod("b", 2, null), mod("a", 1, null)]), "a");
  assert.equal(nextModuleToResume([mod("a", 1, "completed")]), null);
  assert.equal(nextModuleToResume([]), null);
  // a failed (not mid-way) quiz is not "where they left off" ahead of untouched work
  assert.equal(nextModuleToResume([mod("q", 1, "failed"), mod("b", 2, null)]), "q");
});

test("moduleStatusLabel covers every progress state and the locked-out quiz", () => {
  assert.equal(moduleStatusLabel(mod("a", 1, "completed")), "Completed");
  assert.equal(moduleStatusLabel(mod("a", 1, "in_progress")), "In progress");
  assert.equal(moduleStatusLabel(mod("a", 1, "failed")), "Failed - try again");
  assert.equal(moduleStatusLabel(mod("a", 1, "failed", { quiz: { state: "locked_out" } })), "Failed - no attempts left");
  assert.equal(moduleStatusLabel(mod("a", 1, null)), "Not started");
});

test("courseProgressSummary counts required modules only", () => {
  const modules = [mod("a", 1, "completed"), mod("b", 2, null), mod("c", 3, null, { required: false })];
  assert.deepEqual(courseProgressSummary(modules), { completed: 1, total: 2, pct: 50 });
  assert.deepEqual(courseProgressSummary([]), { completed: 0, total: 0, pct: 100 });
});

test("canMarkModuleComplete / canStartQuiz gate on viewer, module type and state", () => {
  const owner = { isOwner: true, canManage: false };
  assert.equal(canMarkModuleComplete(mod("a", 1, null), owner), true);
  assert.equal(canMarkModuleComplete(mod("a", 1, "completed"), owner), false);
  assert.equal(canMarkModuleComplete(mod("a", 1, null, { moduleType: "quiz" }), owner), false);
  assert.equal(canMarkModuleComplete(mod("a", 1, null), { isOwner: false, canManage: false }), false);

  const quizModule = mod("q", 1, null, { moduleType: "quiz", quiz: { state: "not_started" } });
  assert.equal(canStartQuiz(quizModule, owner), true);
  assert.equal(canStartQuiz({ ...quizModule, quiz: { state: "passed" } }, owner), false);
  assert.equal(canStartQuiz({ ...quizModule, quiz: { state: "locked_out" } }, owner), false);
  assert.equal(canStartQuiz(quizModule, { isOwner: false, canManage: true }), false);
  assert.equal(canStartQuiz(mod("a", 1, null), owner), false);
});

test("safeExternalUrl only passes http(s) URLs", () => {
  assert.equal(safeExternalUrl("https://example.com/sop"), "https://example.com/sop");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("data:text/html,x"), null);
  assert.equal(safeExternalUrl("not a url"), null);
  assert.equal(safeExternalUrl(undefined), null);
});

test("checklistItems accepts strings or {label} objects and drops junk", () => {
  assert.deepEqual(checklistItems({ items: ["a", { label: "b" }, 3, "", { nope: 1 }] }), ["a", "b"]);
  assert.deepEqual(checklistItems({}), []);
  assert.deepEqual(checklistItems(null), []);
});

const quiz = { id: "z", questions: [{ id: "q1" }, { id: "q2" }] };

test("buildAnswersPayload / validateQuizSelections", () => {
  assert.deepEqual(buildAnswersPayload(quiz, { q1: new Set(["o1"]), q2: ["o2", "o3"] }), { q1: ["o1"], q2: ["o2", "o3"] });
  assert.deepEqual(buildAnswersPayload(quiz, {}), { q1: [], q2: [] });
  const incomplete = validateQuizSelections(quiz, { q1: new Set(["o1"]) });
  assert.equal(incomplete.valid, false);
  assert.deepEqual(incomplete.unanswered, ["q2"]);
  assert.match(incomplete.message, /1 unanswered/);
  assert.equal(validateQuizSelections(quiz, { q1: ["a"], q2: ["b"] }).valid, true);
  assert.equal(validateQuizSelections({ questions: [] }, {}).valid, false);
});

test("quizResultMessage / quizStatusLine", () => {
  assert.match(quizResultMessage({ passed: true, scorePct: 90, correctCount: 9, totalQuestions: 10 }), /Passed with 90%/);
  assert.match(quizResultMessage({ passed: false, scorePct: 40, passScorePct: 80, attemptsRemaining: 2 }), /80% is required. 2 attempt\(s\) remaining/);
  assert.match(quizResultMessage({ passed: false, scorePct: 40, passScorePct: 80, attemptsRemaining: 0 }), /No attempts remaining/);
  assert.match(quizResultMessage({ passed: false, scorePct: 40, passScorePct: 80, attemptsRemaining: null }), /try again/);
  assert.equal(quizResultMessage(null), "");
  assert.equal(quizStatusLine({ passScorePct: 80, maxAttempts: 3, attemptsUsed: 1, bestScore: 55.4 }), "Pass mark 80% - 1 of 3 attempts used - best score 55%");
  assert.equal(quizStatusLine({ passScorePct: 70, maxAttempts: null, attemptsUsed: 0, bestScore: 0 }), "Pass mark 70% - unlimited attempts");
});

test("dueLabel / assignmentSourceLabel", () => {
  const now = new Date("2026-07-06T12:00:00Z");
  assert.equal(dueLabel(null, now), "No due date");
  assert.equal(dueLabel("2026-07-05T00:00:00Z", now), "Overdue since 2026-07-05");
  assert.match(dueLabel("2026-07-06T20:00:00Z", now), /^Due today/);
  assert.equal(dueLabel("2026-07-09T12:00:00Z", now), "Due 2026-07-09 (3 days)");
  assert.equal(assignmentSourceLabel("role_rule"), "Required for your role");
  assert.equal(assignmentSourceLabel("incident_rule"), "Follow-up from an incident");
  assert.equal(assignmentSourceLabel("???"), "Assigned");
});

test("pending-trigger helpers", () => {
  const certTrigger = { target: { certificationTypeId: "ct" }, certificationTypeName: "CPR" };
  const moduleTrigger = { target: { trainingModuleId: "m" } };
  assert.equal(describeTriggerTarget(certTrigger), "Certification: CPR");
  assert.equal(describeTriggerTarget({ target: { certificationTypeId: "ct" } }), "A certification");
  assert.equal(describeTriggerTarget(moduleTrigger), "Specific training module");
  assert.equal(describeTriggerTarget({ target: {} }), "No target recorded");
  assert.equal(triggerNeedsCoursePick(certTrigger), true);
  assert.equal(triggerNeedsCoursePick(moduleTrigger), false);
  assert.deepEqual(buildAssignTriggerPayload({}), {});
  assert.deepEqual(buildAssignTriggerPayload({ courseId: "c", dueDate: "2026-08-01" }), {
    courseId: "c",
    dueAt: "2026-08-01T23:59:59.000Z"
  });
});
