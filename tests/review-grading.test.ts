import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import type { AnalysisResult } from '../src/issue-classes.js';
import { StubAnalysisClient } from '../src/analysis/stub.js';
import { buildQuestion, containsTarget, createQuestionRow, gradeAnswer, selectDue, type QuestionRow } from '../src/review.js';

let db: DatabaseType;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => {
  db.close();
});

const noIssue: AnalysisResult = {
  issue: null,
  rewrite: '',
  reason: '',
  knowledge_point: null,
  recurrence_of_kp_id: null,
};

function tenseIssue(ruleKey: string): AnalysisResult {
  return {
    issue: { class: 'grammar_error', severity: 'high', span: 'finish', explanation: 'tense' },
    rewrite: 'I finished it yesterday.',
    reason: 'past simple',
    knowledge_point: { kind: 'grammar-rule', canonical_form: `rule ${ruleKey}`, explanation: 'x', rule_key: ruleKey },
    recurrence_of_kp_id: null,
  };
}

async function questionFor(kpId: number): Promise<QuestionRow> {
  const kp = selectDue(db).find((r) => r.id === kpId)!;
  return createQuestionRow(db, kpId, await buildQuestion(db, new StubAnalysisClient(() => null), kp));
}

function reviewState(kpId: number): unknown {
  return db.prepare('SELECT * FROM review_states WHERE knowledge_point_id = ?').get(kpId);
}

describe('grading: an expression unit must actually be used', () => {
  it('matches inflected forms of the target', () => {
    expect(containsTarget('I looked into the crash yesterday.', 'look into')).toBe(true);
    expect(containsTarget('I will check it.', 'look into')).toBe(false);
  });

  it('marks a fluent answer that avoids the target as incorrect', async () => {
    const kpId = seedPoint(db, { canonicalForm: 'look into', issueClass: 'chinglish_collocation' }).knowledgePointId!;
    const question = await questionFor(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => noIssue), question, 'I will check it today.');
    expect(result.verdict).toBe('incorrect');
    expect(result.rating).toBe(1);
    expect(result.feedbackRewrite).toBe('look into');
  });

  it('marks an answer that uses the target without other issues as good', async () => {
    const kpId = seedPoint(db, { canonicalForm: 'look into', issueClass: 'chinglish_collocation' }).knowledgePointId!;
    const question = await questionFor(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => noIssue), question, 'I looked into the crash yesterday.');
    expect(result.verdict).toBe('correct');
    expect(result.rating).toBe(3);
  });
});

describe('grading: a grammar rule needs the model', () => {
  function seedTense(): number {
    return seedPoint(db, {
      canonicalForm: 'past simple for finished actions',
      kind: 'grammar-rule',
      ruleKey: 'tense',
      issueClass: 'grammar_error',
    }).knowledgePointId!;
  }

  it('is ungraded offline and leaves the schedule untouched', async () => {
    const kpId = seedTense();
    const question = await questionFor(kpId);
    const before = reviewState(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => null), question, 'I finished the migration yesterday.');
    expect(result.verdict).toBe('ungraded');
    expect(result.rating).toBeNull();
    expect(result.stateUpdated).toBe(false);
    expect(reviewState(kpId)).toEqual(before);
  });

  it('is incorrect only when the model finds the same rule broken', async () => {
    const kpId = seedTense();
    const question = await questionFor(kpId);
    const same = await gradeAnswer(db, new StubAnalysisClient(() => tenseIssue('tense')), question, 'I finish the migration yesterday.');
    expect(same.verdict).toBe('incorrect');
    expect(same.rating).toBe(1);

    const other = await gradeAnswer(db, new StubAnalysisClient(() => tenseIssue('article')), question, 'I finished migration yesterday.');
    expect(other.verdict).toBe('correct');
    expect(other.rating).toBe(2);
  });
});
