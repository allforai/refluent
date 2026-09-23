import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import type { AnalysisResult } from '../src/issue-classes.js';
import { StubAnalysisClient } from '../src/analysis/stub.js';
import {
  buildQuestion,
  createQuestionRow,
  ensureReviewQuestions,
  gradeAnswer,
  questionContext,
  renderDueNotice,
  runReviewSession,
  selectDue,
  type KnowledgeRow,
  type QuestionRow,
  type ReviewIO,
} from '../src/review.js';

let db: DatabaseType;

beforeEach(() => {
  db = memoryDb();
});

afterEach(() => {
  db.close();
});

function dueRow(id: number): KnowledgeRow {
  const rows = selectDue(db).filter((r) => r.id === id);
  if (rows.length === 0) throw new Error(`knowledge point ${id} is not due`);
  return rows[0];
}

const originalSentence = 'Can you help me look into this bug?';

function seedLookInto(): number {
  const outcome = seedPoint(db, {
    canonicalForm: 'look into',
    originalText: originalSentence,
    issueClass: 'grammar_error',
  });
  return outcome.knowledgePointId!;
}

describe('review: question types keep the original sentence as context', () => {
  it('offline expression-unit falls back to a fill-in on the canonical form', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    expect(built.type).toBe('fill-in');
    expect(built.expected).toBe('look into');
    expect(built.contextInstanceId).not.toBeNull();
    expect(built.prompt).toContain('this bug');
  });

  it('generates a zh-to-en question through the analysis client', async () => {
    const kpId = seedLookInto();
    const client = new StubAnalysisClient(() => null, (request) => ({
      type: 'zh-to-en',
      prompt: '用自然的英文表达：调查这个问题',
      expected: 'look into',
      model: 'stub',
    }));
    const built = await buildQuestion(db, client, dueRow(kpId));
    expect(built.type).toBe('zh-to-en');
    expect(client.calls.generateQuestion[0].type).toBe('zh-to-en');
    expect(built.contextInstanceId).not.toBeNull();
  });

  it('rotates to rewrite-original once the point has been reviewed', async () => {
    const kpId = seedLookInto();
    db.prepare('UPDATE review_states SET reps = 1 WHERE knowledge_point_id = ?').run(kpId);
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    expect(built.type).toBe('rewrite-original');
    expect(built.prompt).toContain(originalSentence);
    expect(built.expected).toBe('look into');
  });

  it('persists the question with its original-sentence context', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    const question = createQuestionRow(db, kpId, built);
    expect(question.context_instance_id).not.toBeNull();
    expect(questionContext(db, question)).toBe(originalSentence);

    expect(renderDueNotice(db)).toBe(
      'refluent: 1 review item(s) from your own sentences are due. Run `refluent review` in a terminal.',
    );
  });
});

describe('review: answers re-enter the same correction pipeline', () => {
  it('filters, analyzes and writes a review-answer instance linked with role=review', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    const question = createQuestionRow(db, kpId, built);

    const answerResult: AnalysisResult = {
      issue: { class: 'grammar_error', severity: 'high', span: 'finish', explanation: 'past tense' },
      rewrite: 'I already finished it yesterday.',
      reason: 'past simple',
      knowledge_point: {
        kind: 'grammar-rule',
        canonical_form: 'already finished',
        explanation: 'past simple',
        rule_key: 'tense',
      },
      recurrence_of_kp_id: null,
    };
    const client = new StubAnalysisClient(() => answerResult);

    const result = await gradeAnswer(db, client, question, 'I already finish it yesterday.');

    // The answer passed through the same filter before the model saw it.
    expect(client.calls.analyze).toHaveLength(1);
    expect(client.calls.analyze[0].filteredText).toBe('I already finish it yesterday.');

    expect(result.verdict).toBe('incorrect');
    expect(result.rating).toBe(1);
    expect(result.instanceId).not.toBeNull();

    const instance = db
      .prepare('SELECT source, issue_class FROM instances WHERE id = ?')
      .get(result.instanceId) as { source: string; issue_class: string };
    expect(instance.source).toBe('refluent:review');
    expect(instance.issue_class).toBe('grammar_error');

    const link = db
      .prepare('SELECT role FROM instance_knowledge_points WHERE instance_id = ?')
      .get(result.instanceId) as { role: string };
    expect(link.role).toBe('review');

    const answerRow = db
      .prepare('SELECT instance_id, verdict, rating FROM review_answers WHERE question_id = ?')
      .get(question.id) as { instance_id: number; verdict: string; rating: number };
    expect(answerRow.instance_id).toBe(result.instanceId);
    expect(answerRow.verdict).toBe('incorrect');
    expect(answerRow.rating).toBe(1);

    // A newly observed issue in an answer creates its own knowledge point.
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get()).toEqual({ n: 2 });
  });

  it('never sends a code-block answer to the model and writes nothing for it', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    const question = createQuestionRow(db, kpId, built);

    const client = new StubAnalysisClient(() => {
      throw new Error('model must not be called for an all-code answer');
    });
    const result = await gradeAnswer(db, client, question, '```ts\nconst x = 1;\n```');

    expect(client.calls.analyze).toHaveLength(0);
    expect(result.instanceId).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM instances').get()).toEqual({ n: 1 }); // only the seed
  });

  it('grades a correct answer as good and advances the schedule', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    const question = createQuestionRow(db, kpId, built);

    const before = db.prepare('SELECT * FROM review_states WHERE knowledge_point_id = ?').get(kpId) as {
      reps: number;
    };
    const result = await gradeAnswer(db, new StubAnalysisClient(() => null), question, 'look into');
    expect(result.verdict).toBe('correct');
    expect(result.rating).toBe(3);

    const after = db.prepare('SELECT reps, last_rating FROM review_states WHERE knowledge_point_id = ?').get(kpId) as {
      reps: number;
      last_rating: number;
    };
    expect(after.reps).toBe(before.reps + 1);
    expect(after.last_rating).toBe(3);
  });

  it('skipping changes no scheduler field and writes no instance', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    const question = createQuestionRow(db, kpId, built);

    const before = db.prepare('SELECT * FROM review_states WHERE knowledge_point_id = ?').get(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => null), question, 'skip');
    const after = db.prepare('SELECT * FROM review_states WHERE knowledge_point_id = ?').get(kpId);

    expect(result.verdict).toBe('skipped');
    expect(result.rating).toBeNull();
    expect(result.stateUpdated).toBe(false);
    expect(result.instanceId).toBeNull();
    expect(after).toEqual(before);
  });
});

describe('review: session selection', () => {
  it('reuses the pending set on the next review run', async () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'one', issueClass: 'grammar_error' });
    seedPoint(db, { canonicalForm: 'walk through', originalText: 'two', issueClass: 'grammar_error' });
    const client = new StubAnalysisClient(() => null);

    const first = await ensureReviewQuestions(db, client);
    expect(first).toHaveLength(2);
    const again = await ensureReviewQuestions(db, client);
    expect(again.map((q) => q.id).sort()).toEqual(first.map((q) => q.id).sort());
  });

  it('returns nothing when no knowledge point is due', async () => {
    expect(renderDueNotice(db)).toBe('');
    expect(await ensureReviewQuestions(db, new StubAnalysisClient(() => null))).toEqual([]);
  });

  it('runs a full review round with the original sentence shown above each prompt', async () => {
    const kpId = seedLookInto();
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    createQuestionRow(db, kpId, built);

    const printed: string[] = [];
    const answers = ['look into'];
    const io: ReviewIO = {
      print: (line) => printed.push(line),
      ask: async () => answers.shift() ?? 'q',
    };
    const summary = await runReviewSession(db, new StubAnalysisClient(() => null), io);
    expect(summary.answered).toBe(1);
    expect(summary.correct).toBe(1);
    expect(summary.exitCode).toBe(0);
    const text = printed.join('\n');
    expect(text).toContain(`Context: "${originalSentence}"`);
    expect(text).toContain('Session: 1 answered, 1 correct.');
  });
});

describe('review: the session summary separates ungraded answers', () => {
  it('names the not-graded count instead of leaving `0 correct` to be misread', async () => {
    const kpId = seedPoint(db, {
      canonicalForm: 'past simple for finished actions',
      kind: 'grammar-rule',
      ruleKey: 'tense',
      issueClass: 'grammar_error',
    }).knowledgePointId!;
    const built = await buildQuestion(db, new StubAnalysisClient(() => null), dueRow(kpId));
    createQuestionRow(db, kpId, built);

    const printed: string[] = [];
    const answers = ['I finished the migration yesterday.'];
    const io: ReviewIO = {
      print: (line) => printed.push(line),
      ask: async () => answers.shift() ?? 'q',
    };
    const summary = await runReviewSession(db, new StubAnalysisClient(() => null), io);
    expect(summary.answered).toBe(1);
    expect(summary.correct).toBe(0);
    expect(summary.notGraded).toBe(1);
    expect(printed.join('\n')).toContain('Session: 1 answered, 0 correct, 1 not graded.');
  });
});