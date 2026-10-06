// TR-07: pure helpers for the quiz surface (quizzes, quiz_questions,
// quiz_options, quiz_option_keys, quiz_attempts; 0065). No I/O: the route
// layer (src/lib/http/training-content-routes.mjs) loads rows and passes
// them in, so everything here is a deterministic transform node:test can
// exercise directly.
//
// Scoring itself is NOT done here -- the authoritative scorer is the
// SECURITY DEFINER RPC internal.submit_quiz_attempt (0065), which reads the
// answer keys with elevated rights so they never have to leave the database.
// What lives here is validation of what a manager authors, validation of the
// shape of what an employee submits, the answer-key-free view of a quiz that
// an employee is allowed to see, and the attempt-state summary the course
// player renders.

export const QUESTION_TYPES = Object.freeze(["single", "multiple"]);

// Bounds that keep a hostile or buggy payload from becoming a giant write.
export const MAX_QUESTIONS_PER_QUIZ = 100;
export const MAX_OPTIONS_PER_QUESTION = 12;
const MAX_TEXT_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

// Validates a quiz definition. `partial` relaxes required fields for PATCH.
export function validateQuizInput(input = {}, { partial = false } = {}) {
  const errors = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(input ?? {}, key);

  if (!partial || has("title")) {
    if (!nonEmptyText(input.title)) errors.push("title is required");
  }
  if (has("passScorePct")) {
    const pct = input.passScorePct;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 1 || pct > 100) {
      errors.push("passScorePct must be a number between 1 and 100");
    }
  }
  if (has("maxAttempts") && input.maxAttempts !== null) {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) {
      errors.push("maxAttempts must be null (unlimited) or an integer between 1 and 100");
    }
  }
  return { valid: errors.length === 0, errors };
}

// Validates one authored question with its options. A single-choice question
// needs exactly one correct option, a multiple-choice question at least one;
// every question needs at least two options.
export function validateQuestionInput(input = {}) {
  const errors = [];
  if (!nonEmptyText(input.prompt)) errors.push("prompt is required");
  const questionType = input.questionType ?? "single";
  if (!QUESTION_TYPES.includes(questionType)) {
    errors.push(`questionType must be one of: ${QUESTION_TYPES.join(", ")}`);
  }
  if (input.points !== undefined && (!Number.isInteger(input.points) || input.points < 1 || input.points > 100)) {
    errors.push("points must be an integer between 1 and 100");
  }
  if (!Number.isInteger(input.orderNo) || input.orderNo < 0) {
    errors.push("orderNo must be a non-negative integer");
  }
  if (!Array.isArray(input.options)) {
    errors.push("options must be an array");
  } else {
    if (input.options.length < 2) errors.push("a question needs at least two options");
    if (input.options.length > MAX_OPTIONS_PER_QUESTION) {
      errors.push(`a question may have at most ${MAX_OPTIONS_PER_QUESTION} options`);
    }
    let correct = 0;
    let optionsWellFormed = true;
    input.options.forEach((option, index) => {
      if (!isPlainObject(option) || !nonEmptyText(option.label)) {
        errors.push(`options[${index}].label is required`);
        optionsWellFormed = false;
        return;
      }
      if (option.isCorrect !== undefined && typeof option.isCorrect !== "boolean") {
        errors.push(`options[${index}].isCorrect must be a boolean`);
        optionsWellFormed = false;
        return;
      }
      if (option.isCorrect === true) correct += 1;
    });
    if (optionsWellFormed) {
      if (correct === 0) errors.push("a question needs at least one correct option");
      if (questionType === "single" && correct > 1) {
        errors.push("a single-choice question must have exactly one correct option");
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// Validates an employee's submitted answers: { "<questionId>": ["<optionId>", ...] }.
// Only SHAPE is checked here (ids are well-formed, bounded); whether an option
// belongs to a question is decided by the RPC against the database.
export function validateAnswersPayload(answers) {
  const errors = [];
  if (!isPlainObject(answers)) return { valid: false, errors: ["answers must be an object keyed by question id"] };
  const entries = Object.entries(answers);
  if (entries.length === 0) errors.push("answers must not be empty");
  if (entries.length > MAX_QUESTIONS_PER_QUIZ) errors.push(`answers may cover at most ${MAX_QUESTIONS_PER_QUIZ} questions`);
  for (const [questionId, selected] of entries) {
    if (!UUID_PATTERN.test(questionId)) {
      errors.push(`"${questionId}" is not a valid question id`);
      continue;
    }
    if (!Array.isArray(selected) || selected.length > MAX_OPTIONS_PER_QUESTION) {
      errors.push(`answers for question ${questionId} must be an array of at most ${MAX_OPTIONS_PER_QUESTION} option ids`);
      continue;
    }
    if (!selected.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
      errors.push(`answers for question ${questionId} contain an invalid option id`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Shapes quiz rows into what a quiz TAKER may see. Whitelists fields, so even
// if a caller accidentally passes rows that carry an answer key (is_correct /
// isCorrect) it can never reach the response.
export function shapeQuizForTaker(quiz, questions = [], options = []) {
  const optionsByQuestion = new Map();
  for (const option of options) {
    const list = optionsByQuestion.get(option.question_id) ?? [];
    list.push({ id: option.id, label: option.label, orderNo: option.order_no });
    optionsByQuestion.set(option.question_id, list);
  }
  return {
    id: quiz.id,
    moduleId: quiz.module_id,
    title: quiz.title,
    passScorePct: Number(quiz.pass_score_pct),
    maxAttempts: quiz.max_attempts ?? null,
    questions: questions
      .filter((question) => question.deleted_at === null || question.deleted_at === undefined)
      .sort((a, b) => a.order_no - b.order_no)
      .map((question) => ({
        id: question.id,
        prompt: question.prompt,
        questionType: question.question_type,
        points: question.points,
        orderNo: question.order_no,
        options: (optionsByQuestion.get(question.id) ?? []).sort((a, b) => a.orderNo - b.orderNo)
      }))
  };
}

// Manager view: the taker view plus each option's isCorrect flag, taken from
// quiz_option_keys rows ({ option_id, is_correct }) that only a training.manage
// caller can read.
export function shapeQuizForManager(quiz, questions = [], options = [], keys = []) {
  const correctByOption = new Map(keys.map((key) => [key.option_id, key.is_correct === true]));
  const shaped = shapeQuizForTaker(quiz, questions, options);
  return {
    ...shaped,
    questions: shaped.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option, isCorrect: correctByOption.get(option.id) === true }))
    }))
  };
}

// Summarises where an employee stands on a quiz from their attempt rows
// ({ attempt_no, score_pct, passed }) and the quiz's max_attempts.
//   passed       a passing attempt exists
//   locked_out   not passed and no attempts left
//   in_progress  at least one failed attempt, attempts remain
//   not_started  no attempts yet
export function quizAttemptState(quiz, attempts = []) {
  const used = attempts.length;
  const maxAttempts = quiz?.max_attempts ?? quiz?.maxAttempts ?? null;
  const bestScore = attempts.reduce((best, attempt) => Math.max(best, Number(attempt.score_pct ?? attempt.scorePct ?? 0)), 0);
  const passed = attempts.some((attempt) => attempt.passed === true);
  const attemptsRemaining = maxAttempts === null ? null : Math.max(maxAttempts - used, 0);
  let state = "not_started";
  if (passed) state = "passed";
  else if (attemptsRemaining === 0) state = "locked_out";
  else if (used > 0) state = "in_progress";
  return { state, attemptsUsed: used, attemptsRemaining, bestScore, passed };
}
