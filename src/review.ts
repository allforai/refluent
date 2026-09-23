import { nowIso } from './config.js';
import type { DatabaseType } from './db.js';
import { FILTER_VERSION, filterNaturalLanguage } from './filter.js';
import type { AnalysisClient, ReviewQuestionType } from './analysis/types.js';
import type { AnalysisResult } from './issue-classes.js';
import { writePath, normalizeCanonical } from './write-path.js';
import { scheduleReview, type RatingValue, type ReviewStateRow } from './scheduler.js';

export interface KnowledgeRow {
  id: number;
  kind: string;
  canonical_form: string;
  rule_key: string | null;
  explanation: string | null;
  due_at: string;
  state: string;
  reps: number;
}

export interface QuestionRow {
  id: number;
  knowledge_point_id: number;
  type: ReviewQuestionType;
  prompt: string;
  expected: string | null;
  context_instance_id: number | null;
  generated_at: string;
  model: string | null;
  status: string;
}

export interface GradeResult {
  verdict: 'correct' | 'incorrect' | 'skipped' | 'ungraded';
  rating: RatingValue | null;
  issueClass: string | null;
  feedbackRewrite: string | null;
  feedbackReason: string | null;
  analysis: AnalysisResult | null;
  stateUpdated: boolean;
  instanceId: number | null;
}

/**
 * True when every token of the target expression appears in the answer. Words
 * of three or more letters may be inflected (`look` matches `looked`).
 */
export function containsTarget(answer: string, target: string): boolean {
  const answerTokens = normalizeCanonical(answer).split(' ').filter(Boolean);
  const targetTokens = normalizeCanonical(target).split(' ').filter(Boolean);
  if (targetTokens.length === 0) return false;
  return targetTokens.every((t) =>
    answerTokens.some((a) => a === t || (t.length >= 3 && a.startsWith(t))),
  );
}

const DUE_SELECT = `
  SELECT kp.id, kp.kind, kp.canonical_form, kp.rule_key, kp.explanation,
         rs.due_at, rs.state, rs.reps
    FROM knowledge_points kp
    JOIN review_states rs ON rs.knowledge_point_id = kp.id
   WHERE kp.status = 'active' AND (rs.due_at <= ? OR rs.state = 'new')
   ORDER BY rs.due_at ASC, kp.id ASC`;

/** All due (or new) knowledge points, ordered by due_at ascending. */
export function selectDue(db: DatabaseType, limit?: number, now = new Date()): KnowledgeRow[] {
  const rows = db.prepare(DUE_SELECT).all(now.toISOString()) as KnowledgeRow[];
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

/** The pending set left by the last session-start teaser, if any. */
export function pendingQuestions(db: DatabaseType): QuestionRow[] {
  return db
    .prepare("SELECT * FROM review_questions WHERE status = 'pending' ORDER BY id ASC")
    .all() as QuestionRow[];
}

export function questionContext(db: DatabaseType, question: QuestionRow): string | null {
  if (question.context_instance_id === null) return null;
  const row = db
    .prepare('SELECT original_text FROM instances WHERE id = ?')
    .get(question.context_instance_id) as { original_text: string } | undefined;
  return row?.original_text ?? null;
}

function contextInstanceIdFor(db: DatabaseType, knowledgePointId: number): number | null {
  const row = db
    .prepare(
      `SELECT COALESCE(kp.first_instance_id, (
          SELECT i.id FROM instances i
            JOIN instance_knowledge_points l ON l.instance_id = i.id
           WHERE l.knowledge_point_id = kp.id
           ORDER BY i.id ASC LIMIT 1)) AS instance_id
         FROM knowledge_points kp WHERE kp.id = ?`,
    )
    .get(knowledgePointId) as { instance_id: number | null } | undefined;
  return row?.instance_id ?? null;
}

export interface BuiltQuestion {
  type: ReviewQuestionType;
  prompt: string;
  expected: string | null;
  contextInstanceId: number | null;
  model: string | null;
}

function fillInPrompt(canonical: string, context: string | null, explanation: string | null): string {
  if (context) {
    const idx = context.toLowerCase().indexOf(canonical.toLowerCase());
    if (idx >= 0) {
      const blanked = `${context.slice(0, idx)}____${context.slice(idx + canonical.length)}`;
      return `Fill in the blank with the natural English expression.\n  ${blanked}`;
    }
  }
  const meaning = explanation ? ` (meaning: ${explanation})` : '';
  return `Write the English expression with the blank filled in: ____${meaning}`;
}

/**
 * Chooses one production question for a knowledge point.
 *
 * A grammar-rule point asks for a freshly generated sentence so the learner
 * transfers the rule; when the model is unavailable it falls back to a fill-in
 * on the canonical form so reviews still work offline.
 */
export async function buildQuestion(
  db: DatabaseType,
  client: AnalysisClient,
  kp: KnowledgeRow,
): Promise<BuiltQuestion> {
  const contextInstanceId = contextInstanceIdFor(db, kp.id);
  const context = contextInstanceId === null
    ? null
    : (db.prepare('SELECT original_text FROM instances WHERE id = ?').get(contextInstanceId) as
        | { original_text: string }
        | undefined)?.original_text ?? null;

  const knowledgePoint = {
    id: kp.id,
    kind: kp.kind === 'grammar-rule' ? ('grammar-rule' as const) : ('expression-unit' as const),
    canonicalForm: kp.canonical_form,
    explanation: kp.explanation,
    ruleKey: kp.rule_key,
  };

  const offlineFillIn = (): BuiltQuestion => ({
    type: 'fill-in',
    prompt: fillInPrompt(kp.canonical_form, context, kp.explanation),
    expected: kp.canonical_form,
    contextInstanceId,
    model: null,
  });

  if (knowledgePoint.kind === 'grammar-rule') {
    const filteredContext = context ? filterNaturalLanguage(context).filteredText : null;
    const generated = await client.generateQuestion({
      knowledgePoint,
      type: 'rewrite-original',
      contextSentence: filteredContext,
    });
    if (generated) {
      return {
        type: generated.type,
        prompt: generated.prompt,
        expected: generated.expected ?? kp.canonical_form,
        contextInstanceId,
        model: generated.model ?? null,
      };
    }
    return offlineFillIn();
  }

  const rotation = ((kp.reps % 3) + 3) % 3;
  if (rotation === 0) {
    const filteredContext = context ? filterNaturalLanguage(context).filteredText : null;
    const generated = await client.generateQuestion({
      knowledgePoint,
      type: 'zh-to-en',
      contextSentence: filteredContext,
    });
    if (generated) {
      return {
        type: generated.type,
        prompt: generated.prompt,
        expected: generated.expected ?? kp.canonical_form,
        contextInstanceId,
        model: generated.model ?? null,
      };
    }
    return offlineFillIn();
  }
  if (rotation === 1) {
    return {
      type: 'rewrite-original',
      prompt: `Rewrite this sentence more naturally:\n  "${context ?? kp.canonical_form}"`,
      expected: kp.canonical_form,
      contextInstanceId,
      model: null,
    };
  }
  return offlineFillIn();
}

export function createQuestionRow(
  db: DatabaseType,
  knowledgePointId: number,
  built: BuiltQuestion,
): QuestionRow {
  const info = db
    .prepare(
      `INSERT INTO review_questions
        (knowledge_point_id, type, prompt, expected, context_instance_id, generated_at, model, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      knowledgePointId,
      built.type,
      built.prompt,
      built.expected,
      built.contextInstanceId,
      nowIso(),
      built.model,
    );
  return db
    .prepare('SELECT * FROM review_questions WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as QuestionRow;
}

/** Take the full due set for `refluent review`, persisting question rows. */
export async function ensureReviewQuestions(
  db: DatabaseType,
  client: AnalysisClient,
  limit = 20,
): Promise<QuestionRow[]> {
  const pending = pendingQuestions(db);
  if (pending.length > 0) return pending;
  const due = selectDue(db, limit);
  const created: QuestionRow[] = [];
  for (const kp of due) {
    created.push(createQuestionRow(db, kp.id, await buildQuestion(db, client, kp)));
  }
  return created;
}

function knowledgeRow(db: DatabaseType, id: number): KnowledgeRow | null {
  const row = db
    .prepare(
      `SELECT kp.id, kp.kind, kp.canonical_form, kp.rule_key, kp.explanation,
              rs.due_at, rs.state, rs.reps
         FROM knowledge_points kp
         JOIN review_states rs ON rs.knowledge_point_id = kp.id
        WHERE kp.id = ?`,
    )
    .get(id) as KnowledgeRow | undefined;
  return row ?? null;
}

function knowledgePointClass(db: DatabaseType, id: number): string | null {
  const row = db
    .prepare(
      `SELECT i.issue_class FROM instances i
         JOIN instance_knowledge_points l ON l.instance_id = i.id
        WHERE l.knowledge_point_id = ? AND i.issue_class IS NOT NULL
        ORDER BY i.id DESC LIMIT 1`,
    )
    .get(id) as { issue_class: string } | undefined;
  return row?.issue_class ?? null;
}

function updateSchedule(db: DatabaseType, knowledgePointId: number, rating: RatingValue, now: Date): boolean {
  const row = db
    .prepare('SELECT * FROM review_states WHERE knowledge_point_id = ?')
    .get(knowledgePointId) as ReviewStateRow | undefined;
  if (!row) return false;
  const scheduled = scheduleReview(row, rating, now);
  db.prepare(
    `UPDATE review_states
        SET due_at = ?, state = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?,
            last_review_at = ?, last_rating = ?, updated_at = ?
      WHERE knowledge_point_id = ?`,
  ).run(
    scheduled.due_at,
    scheduled.state,
    scheduled.stability,
    scheduled.difficulty,
    scheduled.reps,
    scheduled.lapses,
    scheduled.last_review_at,
    scheduled.last_rating,
    now.toISOString(),
    knowledgePointId,
  );
  return true;
}

/**
 * Grades one answer, feeding errors back through the same filter -> analyze ->
 * write path as a captured message, then advancing the FSRS schedule.
 */
export async function gradeAnswer(
  db: DatabaseType,
  client: AnalysisClient,
  question: QuestionRow,
  answerText: string,
  now: Date = new Date(),
): Promise<GradeResult> {
  const kp = knowledgeRow(db, question.knowledge_point_id);
  if (!kp) {
    return {
      verdict: 'incorrect',
      rating: null,
      issueClass: null,
      feedbackRewrite: null,
      feedbackReason: 'knowledge point not found',
      analysis: null,
      stateUpdated: false,
      instanceId: null,
    };
  }

  const trimmed = answerText.trim();
  const at = now.toISOString();
  const skipped = trimmed.length === 0 || /^(skip|s|pass|q)$/i.test(trimmed);

  if (skipped) {
    db.prepare(
      `INSERT INTO review_answers
        (question_id, answer_text, verdict, issue_class, feedback_rewrite, feedback_reason,
         instance_id, rating, created_at, duration_ms)
       VALUES (?, ?, 'skipped', NULL, NULL, ?, NULL, NULL, ?, NULL)`,
    ).run(question.id, answerText, 'Skipped — your review schedule is unchanged.', at);
    db.prepare("UPDATE review_questions SET status = 'answered' WHERE id = ?").run(question.id);
    return {
      verdict: 'skipped',
      rating: null,
      issueClass: null,
      feedbackRewrite: null,
      feedbackReason: 'Skipped — your review schedule is unchanged.',
      analysis: null,
      stateUpdated: false,
      instanceId: null,
    };
  }

  // Answers re-enter the same choke point; only a passing filter may be analyzed.
  const filtered = filterNaturalLanguage(answerText);
  const analysis = filtered.filteredText
    ? await client.analyze({ filteredText: filtered.filteredText, filterVersion: FILTER_VERSION })
    : null;

  const target = question.expected ?? kp.canonical_form;
  const issue = analysis?.issue ?? null;

  let verdict: GradeResult['verdict'];
  let rating: RatingValue | null;
  if (kp.kind !== 'grammar-rule') {
    // An expression unit is learned only if the answer actually uses it.
    if (!containsTarget(trimmed, target)) {
      verdict = 'incorrect';
      rating = 1;
    } else {
      verdict = 'correct';
      rating = issue ? 2 : 3;
    }
  } else if (!analysis) {
    // A grammar rule cannot be judged by string matching; without the model the
    // answer is recorded but the schedule is left alone.
    verdict = 'ungraded';
    rating = null;
  } else {
    const sameRule = issue !== null && (kp.rule_key
      ? analysis.knowledge_point?.rule_key === kp.rule_key
      : issue.class === knowledgePointClass(db, kp.id));
    verdict = sameRule ? 'incorrect' : 'correct';
    rating = sameRule ? 1 : issue ? 2 : 3;
  }

  let instanceId: number | null = null;
  if (analysis && analysis.issue && filtered.filteredText) {
    const outcome = writePath(db, analysis, 'refluent:review', {
      originalText: filtered.filteredText,
      filterVersion: FILTER_VERSION,
    });
    instanceId = outcome.written ? (outcome.instanceId ?? null) : null;
  }

  const stateUpdated = rating === null ? false : updateSchedule(db, kp.id, rating, now);
  const feedbackRewrite = issue ? analysis!.rewrite : verdict === 'incorrect' ? target : null;
  const feedbackReason = issue
    ? analysis!.reason
    : verdict === 'ungraded'
      ? 'Could not grade this answer without the analysis model; your schedule is unchanged.'
      : verdict === 'correct'
        ? 'Looks good — no improvement needed.'
        : `Use the target expression: "${target}".`;

  db.prepare(
    `INSERT INTO review_answers
      (question_id, answer_text, verdict, issue_class, feedback_rewrite, feedback_reason,
       instance_id, rating, created_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    question.id,
    answerText,
    verdict,
    issue?.class ?? null,
    feedbackRewrite,
    feedbackReason,
    instanceId,
    rating,
    at,
  );
  db.prepare("UPDATE review_questions SET status = 'answered' WHERE id = ?").run(question.id);

  return {
    verdict,
    rating,
    issueClass: issue?.class ?? null,
    feedbackRewrite,
    feedbackReason,
    analysis,
    stateUpdated,
    instanceId,
  };
}

export interface ReviewIO {
  print(line: string): void;
  ask(prompt: string): Promise<string>;
}

export interface ReviewSummary {
  asked: number;
  answered: number;
  correct: number;
  /** Answers the model could not grade; neither correct nor wrong, so never folded into `correct`. */
  notGraded: number;
  exitCode: number;
}

/** Interactive `refluent review` round. Keeps completed results on early exit. */
export async function runReviewSession(
  db: DatabaseType,
  client: AnalysisClient,
  io: ReviewIO,
  now: Date = new Date(),
): Promise<ReviewSummary> {
  const questions = await ensureReviewQuestions(db, client);
  if (questions.length === 0) {
    io.print('refluent: no reviewable content yet — keep coding and your own sentences will accumulate here.');
    return { asked: 0, answered: 0, correct: 0, notGraded: 0, exitCode: 0 };
  }

  io.print(`refluent review: ${questions.length} question(s) from your own sentences.`);
  let answered = 0;
  let correct = 0;
  let notGraded = 0;

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const context = questionContext(db, question);
    io.print('');
    io.print(`Question ${i + 1}/${questions.length} [${question.type}]`);
    io.print(question.prompt);
    if (context) io.print(`  Context: "${context}"`);
    const answer = (await io.ask('Your answer (or press Enter to skip, q to quit): ')).trim();
    if (/^(q|quit)$/i.test(answer)) break;
    const result = await gradeAnswer(db, client, question, answer, now);
    answered += 1;
    if (result.verdict === 'correct') correct += 1;
    if (result.verdict === 'ungraded') notGraded += 1;
    const verdictLabel = result.verdict === 'skipped'
      ? 'Skipped'
      : result.verdict === 'ungraded'
        ? 'Not graded'
        : result.verdict === 'correct'
          ? 'Correct'
          : 'Needs work';
    io.print(`${verdictLabel}. ${result.feedbackReason ?? ''}`.trim());
    if (result.feedbackRewrite) io.print(`More natural: ${result.feedbackRewrite}`);
  }

  io.print('');
  // "not graded" is stated on its own so a reader never takes `0 correct` for "you got them wrong".
  const notGradedSuffix = notGraded > 0 ? `, ${notGraded} not graded` : '';
  io.print(`Session: ${answered} answered, ${correct} correct${notGradedSuffix}.`);
  return { asked: questions.length, answered, correct, notGraded, exitCode: 0 };
}

/**
 * The session-start notice. It carries only a count, never a prompt or an
 * original sentence, so nothing from past messages reaches the screen or the agent.
 */
export function renderDueNotice(db: DatabaseType, now: Date = new Date()): string {
  const due = selectDue(db, undefined, now).length;
  if (due === 0) return '';
  return `refluent: ${due} review item(s) from your own sentences are due. Run \`refluent review\` in a terminal.`;
}