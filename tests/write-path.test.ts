import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb } from './helpers.js';
import { tokenJaccard, matchKey, normalizeCanonical, writePath } from '../src/write-path.js';
import type { DatabaseType } from '../src/db.js';
import type { AnalysisResult } from '../src/issue-classes.js';

let db: DatabaseType;

beforeEach(() => {
  db = memoryDb();
});

afterEach(() => {
  db.close();
});

function kp(canonical: string) {
  return {
    issue: { class: 'chinglish_collocation' as const, severity: 'medium' as const, span: canonical, explanation: 'x' },
    rewrite: 'More natural.',
    reason: 'why',
    knowledge_point: {
      kind: 'expression-unit' as const,
      canonical_form: canonical,
      explanation: 'x',
      rule_key: null,
    },
    recurrence_of_kp_id: null,
  } satisfies AnalysisResult;
}

describe('write path: normalization and match keys', () => {
  it('normalizes case, whitespace and outer punctuation but keeps internal apostrophes/hyphens', () => {
    expect(normalizeCanonical('  “Look Into”  ')).toBe('look into');
    expect(normalizeCanonical("It's a well-known issue")).toBe("it's a well-known issue");
  });

  it('builds a stable kind-scoped match key', () => {
    expect(matchKey('expression-unit', 'Look Into')).toBe('expression-unit:look into');
    expect(matchKey('grammar-rule', 'Look Into')).toBe('grammar-rule:look into');
  });

  it('computes token-level Jaccard similarity', () => {
    expect(tokenJaccard('look into the bug', 'look into bug')).toBeCloseTo(0.75);
    expect(tokenJaccard('look into', 'check the logs')).toBe(0);
  });
});

describe('write path: new knowledge point vs recurrence', () => {
  it('creates a knowledge point, origin link and review state on first sight', () => {
    const outcome = writePath(db, kp('look into'), 'claude-code:UserPromptSubmit', {
      originalText: 'Can you help me look this bug?',
      messageId: 'm1',
    });
    expect(outcome.written).toBe(true);
    expect(outcome.createdKnowledgePoint).toBe(true);
    expect(outcome.role).toBe('origin');

    const points = db.prepare('SELECT * FROM knowledge_points').all() as Array<Record<string, unknown>>;
    expect(points).toHaveLength(1);
    expect(points[0].occurrence_count).toBe(1);
    const links = db.prepare('SELECT role FROM instance_knowledge_points').all() as Array<{ role: string }>;
    expect(links.map((l) => l.role)).toEqual(['origin']);
    const states = db.prepare('SELECT state FROM review_states').all() as Array<{ state: string }>;
    expect(states).toHaveLength(1);
    expect(states[0].state).toBe('new');
  });

  it('links an exact canonical recurrence as a new instance of the same point', () => {
    writePath(db, kp('Look Into'), 'claude-code:UserPromptSubmit', { originalText: 'first', messageId: 'm1' });
    const second = writePath(db, kp('look   into'), 'claude-code:UserPromptSubmit', {
      originalText: 'second',
      messageId: 'm2',
    });
    expect(second.createdKnowledgePoint).toBe(false);
    expect(second.role).toBe('recurrence');
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM instances').get()).toEqual({ n: 2 });
    const occurrence = db.prepare('SELECT occurrence_count FROM knowledge_points').get() as {
      occurrence_count: number;
    };
    expect(occurrence.occurrence_count).toBe(2);
    const roles = db
      .prepare('SELECT role FROM instance_knowledge_points ORDER BY instance_id')
      .all() as Array<{ role: string }>;
    expect(roles.map((r) => r.role)).toEqual(['origin', 'recurrence']);
  });

  it('accepts a model-assisted recurrence only above the Jaccard threshold', () => {
    const first = writePath(db, kp('look into the failing test'), 'claude-code:UserPromptSubmit', {
      originalText: 'first',
      messageId: 'm1',
    });
    const assisted = kp('look into failing test');
    assisted.recurrence_of_kp_id = first.knowledgePointId!;
    const second = writePath(db, assisted, 'claude-code:UserPromptSubmit', {
      originalText: 'second',
      messageId: 'm2',
    });
    expect(second.knowledgePointId).toBe(first.knowledgePointId);
    expect(second.role).toBe('recurrence');

    const unrelated = kp('separate concern entirely');
    unrelated.recurrence_of_kp_id = first.knowledgePointId!;
    const third = writePath(db, unrelated, 'claude-code:UserPromptSubmit', {
      originalText: 'third',
      messageId: 'm3',
    });
    expect(third.createdKnowledgePoint).toBe(true);
  });

  it('writes nothing when the analysis reports no issue', () => {
    const outcome = writePath(
      db,
      { issue: null, rewrite: 'ok', reason: '', knowledge_point: null, recurrence_of_kp_id: null },
      'claude-code:UserPromptSubmit',
      { originalText: 'nothing' },
    );
    expect(outcome.written).toBe(false);
    expect(outcome.reason).toBe('no_issue');
    expect(db.prepare('SELECT COUNT(*) AS n FROM instances').get()).toEqual({ n: 0 });
  });

  it('rejects canonical forms outside the length guard', () => {
    const tooShort = writePath(db, kp('a'), 'claude-code:UserPromptSubmit', { originalText: 'x' });
    expect(tooShort.written).toBe(false);
    expect(tooShort.reason).toBe('canonical_form_length');

    const tooLong = writePath(db, kp('word '.repeat(60)), 'claude-code:UserPromptSubmit', { originalText: 'x' });
    expect(tooLong.reason).toBe('canonical_form_length');
  });

  it('tags a review answer link with role=review instead of recurrence', () => {
    const first = writePath(db, kp('look into'), 'claude-code:UserPromptSubmit', { originalText: 'first' });
    const reviewed = writePath(db, kp('look into'), 'refluent:review', { originalText: 'answer' });
    expect(reviewed.knowledgePointId).toBe(first.knowledgePointId);
    expect(reviewed.role).toBe('review');
  });
});