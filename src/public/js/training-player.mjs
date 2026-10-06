// Pure logic behind the training panel's course player, quiz taker and
// pending-incident-training list (TR-07/TR-08/TR-10). No DOM, no fetch --
// src/public/js/app.js's trainingPanel does the I/O and the el() rendering;
// everything decidable lives here so test/training-player.test.mjs can cover
// it. The shapes consumed are the ones GET /training-assignments/:id/player,
// GET .../quiz and GET .../incident-training-triggers return.

const DAY_MS = 24 * 60 * 60 * 1000;

// "Resume where left off": the module a learner should open next. A module
// that was started but not finished wins (they were mid-way through it);
// otherwise the first not-yet-completed module in course order. null when
// every module is complete.
export function nextModuleToResume(modules = []) {
  const ordered = [...modules].sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
  const open = ordered.filter((module) => module.progress?.state !== "completed");
  if (open.length === 0) return null;
  const started = open.find((module) => module.progress?.startedAt && module.progress.state !== "failed");
  return (started ?? open[0]).id;
}

export function moduleStatusLabel(module) {
  switch (module?.progress?.state) {
    case "completed":
      return "Completed";
    case "in_progress":
      return "In progress";
    case "failed":
      return module.quiz?.state === "locked_out" ? "Failed - no attempts left" : "Failed - try again";
    default:
      return "Not started";
  }
}

// Completed / total over the REQUIRED modules (the set TR-06's completion
// gate counts), as whole-number percentage.
export function courseProgressSummary(modules = []) {
  const required = modules.filter((module) => module.required !== false);
  const completed = required.filter((module) => module.progress?.state === "completed").length;
  const total = required.length;
  return { completed, total, pct: total === 0 ? 100 : Math.round((completed / total) * 100) };
}

// Whether the learner can mark a non-quiz module complete by hand. A quiz
// module is completed only by passing the quiz.
export function canMarkModuleComplete(module, viewer = {}) {
  if (!viewer.isOwner && !viewer.canManage) return false;
  if (module.moduleType === "quiz") return false;
  return module.progress?.state !== "completed";
}

export function canStartQuiz(module, viewer = {}) {
  if (!viewer.isOwner || module.moduleType !== "quiz" || !module.quiz) return false;
  return module.quiz.state !== "passed" && module.quiz.state !== "locked_out";
}

// Only http(s) URLs may become a clickable link (sop_link modules carry a
// free-form content_jsonb); anything else renders as plain text.
export function safeExternalUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function checklistItems(content) {
  const items = content?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => (typeof item === "string" ? item : item?.label)).filter((text) => typeof text === "string" && text.trim());
}

// --- Quiz taking ------------------------------------------------------------

// selections: { [questionId]: Set<optionId> | optionId[] }. Returns the
// answers payload { [questionId]: optionId[] } the attempts route expects.
export function buildAnswersPayload(quiz, selections = {}) {
  const answers = {};
  for (const question of quiz?.questions ?? []) {
    const chosen = selections[question.id];
    answers[question.id] = chosen ? [...chosen] : [];
  }
  return answers;
}

// Every question needs at least one selected option before the form submits.
export function validateQuizSelections(quiz, selections = {}) {
  const unanswered = (quiz?.questions ?? []).filter((question) => {
    const chosen = selections[question.id];
    return !chosen || [...chosen].length === 0;
  });
  return {
    valid: unanswered.length === 0 && (quiz?.questions ?? []).length > 0,
    unanswered: unanswered.map((question) => question.id),
    message:
      unanswered.length === 0
        ? null
        : `Answer every question before submitting (${unanswered.length} unanswered).`
  };
}

// Human summary of an attempt result (POST .../attempts response).
export function quizResultMessage(result) {
  if (!result) return "";
  const score = `${Number(result.scorePct)}%`;
  if (result.passed) return `Passed with ${score} (${result.correctCount} of ${result.totalQuestions} correct).`;
  const remaining =
    result.attemptsRemaining === null || result.attemptsRemaining === undefined
      ? "You can try again."
      : result.attemptsRemaining > 0
        ? `${result.attemptsRemaining} attempt(s) remaining.`
        : "No attempts remaining - contact your supervisor.";
  return `Scored ${score}; ${Number(result.passScorePct)}% is required. ${remaining}`;
}

export function quizStatusLine(quiz) {
  if (!quiz) return "";
  const parts = [`Pass mark ${quiz.passScorePct}%`];
  parts.push(quiz.maxAttempts === null ? "unlimited attempts" : `${quiz.attemptsUsed ?? 0} of ${quiz.maxAttempts} attempts used`);
  if (quiz.attemptsUsed > 0) parts.push(`best score ${Math.round(quiz.bestScore)}%`);
  return parts.join(" - ");
}

// --- Assignments ------------------------------------------------------------

export function dueLabel(dueAt, now = new Date()) {
  if (!dueAt) return "No due date";
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "No due date";
  const date = due.toISOString().slice(0, 10);
  if (due.getTime() < now.getTime()) return `Overdue since ${date}`;
  if (date === now.toISOString().slice(0, 10)) return `Due today (${date})`;
  const days = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
  return `Due ${date} (${days} day${days === 1 ? "" : "s"})`;
}

const SOURCE_LABELS = {
  manual: "Assigned by a supervisor",
  role_rule: "Required for your role",
  certification_rule: "Required for a certification",
  incident_rule: "Follow-up from an incident"
};

export function assignmentSourceLabel(sourceType) {
  return SOURCE_LABELS[sourceType] ?? "Assigned";
}

// --- Pending incident training (TR-10) --------------------------------------

export function describeTriggerTarget(trigger) {
  const target = trigger?.target ?? {};
  if (target.trainingModuleId) return "Specific training module";
  if (target.certificationTypeId) {
    return trigger.certificationTypeName ? `Certification: ${trigger.certificationTypeName}` : "A certification";
  }
  return "No target recorded";
}

// A trigger that names a certification type has no course of its own: the
// manager must pick one (or a certification rule must already link one).
export function triggerNeedsCoursePick(trigger) {
  return Boolean(trigger?.target?.certificationTypeId) && !trigger?.target?.trainingModuleId;
}

export function buildAssignTriggerPayload({ courseId, dueDate } = {}) {
  const payload = {};
  if (courseId) payload.courseId = courseId;
  if (dueDate) payload.dueAt = new Date(`${dueDate}T23:59:59.000Z`).toISOString();
  return payload;
}
