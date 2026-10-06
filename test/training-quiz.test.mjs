import test from "node:test";
import assert from "node:assert/strict";
import {
  validateQuizInput,
  validateQuestionInput,
  validateAnswersPayload,
  shapeQuizForTaker,
  shapeQuizForManager,
  quizAttemptState,
  MAX_OPTIONS_PER_QUESTION
} from "../src/lib/training-quiz.mjs";

const Q1 = "11111111-1111-4111-8111-111111111111";
const O1 = "22222222-2222-4222-8222-222222222222";

test("validateQuizInput requires a title and bounds passScorePct / maxAttempts", () => {
  assert.equal(validateQuizInput({ title: "Safety" }).valid, true);
  assert.equal(validateQuizInput({ title: "Safety", passScorePct: 80, maxAttempts: 3 }).valid, true);
  assert.equal(validateQuizInput({ title: "Safety", maxAttempts: null }).valid, true);
  assert.equal(validateQuizInput({}).valid, false);
  assert.equal(validateQuizInput({ title: "  " }).valid, false);
  assert.equal(validateQuizInput({ title: "x", passScorePct: 0 }).valid, false);
  assert.equal(validateQuizInput({ title: "x", passScorePct: 101 }).valid, false);
  assert.equal(validateQuizInput({ title: "x", maxAttempts: 0 }).valid, false);
  assert.equal(validateQuizInput({ title: "x", maxAttempts: 1.5 }).valid, false);
});

test("validateQuizInput({partial}) only checks the fields present", () => {
  assert.equal(validateQuizInput({}, { partial: true }).valid, true);
  assert.equal(validateQuizInput({ passScorePct: 70 }, { partial: true }).valid, true);
  assert.equal(validateQuizInput({ passScorePct: 700 }, { partial: true }).valid, false);
  assert.equal(validateQuizInput({ title: "" }, { partial: true }).valid, false);
});

const goodQuestion = {
  prompt: "Which is right?",
  questionType: "single",
  orderNo: 1,
  options: [{ label: "A", isCorrect: true }, { label: "B" }]
};

test("validateQuestionInput accepts a well-formed single and multiple choice question", () => {
  assert.equal(validateQuestionInput(goodQuestion).valid, true);
  assert.equal(
    validateQuestionInput({
      ...goodQuestion,
      questionType: "multiple",
      options: [{ label: "A", isCorrect: true }, { label: "B", isCorrect: true }, { label: "C" }]
    }).valid,
    true
  );
});

test("validateQuestionInput enforces the correct-answer rules per question type", () => {
  const none = validateQuestionInput({ ...goodQuestion, options: [{ label: "A" }, { label: "B" }] });
  assert.equal(none.valid, false);
  assert.match(none.errors.join(" "), /at least one correct/);
  const two = validateQuestionInput({ ...goodQuestion, options: [{ label: "A", isCorrect: true }, { label: "B", isCorrect: true }] });
  assert.equal(two.valid, false);
  assert.match(two.errors.join(" "), /exactly one correct/);
});

test("validateQuestionInput rejects malformed questions", () => {
  assert.equal(validateQuestionInput({ ...goodQuestion, prompt: "" }).valid, false);
  assert.equal(validateQuestionInput({ ...goodQuestion, questionType: "essay" }).valid, false);
  assert.equal(validateQuestionInput({ ...goodQuestion, orderNo: -1 }).valid, false);
  assert.equal(validateQuestionInput({ ...goodQuestion, points: 0 }).valid, false);
  assert.equal(validateQuestionInput({ ...goodQuestion, options: [{ label: "only", isCorrect: true }] }).valid, false);
  assert.equal(validateQuestionInput({ ...goodQuestion, options: "nope" }).valid, false);
  assert.equal(validateQuestionInput({ ...goodQuestion, options: [{ label: "A", isCorrect: "yes" }, { label: "B" }] }).valid, false);
  const tooMany = Array.from({ length: MAX_OPTIONS_PER_QUESTION + 1 }, (_, index) => ({ label: `o${index}`, isCorrect: index === 0 }));
  assert.equal(validateQuestionInput({ ...goodQuestion, options: tooMany }).valid, false);
});

test("validateAnswersPayload checks shape only", () => {
  assert.equal(validateAnswersPayload({ [Q1]: [O1] }).valid, true);
  assert.equal(validateAnswersPayload({ [Q1]: [] }).valid, true);
  assert.equal(validateAnswersPayload(null).valid, false);
  assert.equal(validateAnswersPayload([]).valid, false);
  assert.equal(validateAnswersPayload({}).valid, false);
  assert.equal(validateAnswersPayload({ "not-a-uuid": [O1] }).valid, false);
  assert.equal(validateAnswersPayload({ [Q1]: "oops" }).valid, false);
  assert.equal(validateAnswersPayload({ [Q1]: ["x"] }).valid, false);
  assert.equal(validateAnswersPayload({ [Q1]: [{ id: O1 }] }).valid, false);
});

const quiz = { id: "quiz-1", module_id: "mod-1", title: "Safety", pass_score_pct: "80.00", max_attempts: 3 };
const questions = [
  { id: "q2", prompt: "Second", question_type: "multiple", points: 2, order_no: 2, deleted_at: null },
  { id: "q1", prompt: "First", question_type: "single", points: 1, order_no: 1, deleted_at: null },
  { id: "q3", prompt: "Removed", question_type: "single", points: 1, order_no: 3, deleted_at: "2026-01-01" }
];
// Rows that (wrongly) carry a key column must never leak through the taker view.
const options = [
  { id: "o2", question_id: "q1", label: "B", order_no: 2, is_correct: false },
  { id: "o1", question_id: "q1", label: "A", order_no: 1, is_correct: true },
  { id: "o3", question_id: "q2", label: "C", order_no: 1, is_correct: true }
];

test("shapeQuizForTaker orders questions/options, drops deleted questions and NEVER carries an answer key", () => {
  const shaped = shapeQuizForTaker(quiz, questions, options);
  assert.equal(shaped.passScorePct, 80);
  assert.deepEqual(shaped.questions.map((q) => q.id), ["q1", "q2"]);
  assert.deepEqual(shaped.questions[0].options.map((o) => o.id), ["o1", "o2"]);
  const serialized = JSON.stringify(shaped);
  assert.equal(serialized.includes("is_correct"), false);
  assert.equal(serialized.includes("isCorrect"), false);
});

test("shapeQuizForManager adds isCorrect from the key rows only", () => {
  const keys = [
    { option_id: "o1", is_correct: true },
    { option_id: "o2", is_correct: false },
    { option_id: "o3", is_correct: true }
  ];
  const shaped = shapeQuizForManager(quiz, questions, options, keys);
  assert.deepEqual(shaped.questions[0].options.map((o) => o.isCorrect), [true, false]);
  assert.equal(shaped.questions[1].options[0].isCorrect, true);
  // No key rows at all (a non-manager's RLS-filtered read): everything false, nothing inferred.
  const blind = shapeQuizForManager(quiz, questions, options, []);
  assert.equal(JSON.stringify(blind).includes('"isCorrect":true'), false);
});

test("quizAttemptState summarises passed / locked_out / in_progress / not_started", () => {
  assert.equal(quizAttemptState({ max_attempts: 3 }, []).state, "not_started");
  const failed = quizAttemptState({ max_attempts: 3 }, [{ score_pct: 40, passed: false }]);
  assert.equal(failed.state, "in_progress");
  assert.equal(failed.attemptsRemaining, 2);
  assert.equal(failed.bestScore, 40);
  assert.equal(quizAttemptState({ max_attempts: 2 }, [{ score_pct: 10, passed: false }, { score_pct: 20, passed: false }]).state, "locked_out");
  const passed = quizAttemptState({ max_attempts: 2 }, [{ score_pct: 10, passed: false }, { score_pct: 90, passed: true }]);
  assert.equal(passed.state, "passed");
  assert.equal(passed.bestScore, 90);
  assert.equal(quizAttemptState({ max_attempts: null }, [{ score_pct: 1, passed: false }]).attemptsRemaining, null);
});
