import { openDatabase, type DatabaseType } from '../src/db.js';
import { writePath, type WriteOutcome } from '../src/write-path.js';
import type { AnalysisResult, IssueClass, KnowledgePointKind } from '../src/issue-classes.js';

/** Every suite runs against the real schema in an in-memory SQLite database. */
export function memoryDb(): DatabaseType {
  return openDatabase(':memory:');
}

export interface SeedOptions {
  canonicalForm: string;
  kind?: KnowledgePointKind;
  issueClass?: IssueClass;
  ruleKey?: string | null;
  originalText?: string;
  rewrite?: string;
  reason?: string;
  explanation?: string;
  recurrenceOf?: number | null;
}

export function resultFor(options: SeedOptions): AnalysisResult {
  return {
    issue: {
      class: options.issueClass ?? 'chinglish_collocation',
      severity: 'medium',
      span: options.canonicalForm,
      explanation: options.explanation ?? 'natural phrasing',
    },
    rewrite: options.rewrite ?? `Please ${options.canonicalForm}.`,
    reason: options.reason ?? 'more natural phrasing',
    knowledge_point: {
      kind: options.kind ?? 'expression-unit',
      canonical_form: options.canonicalForm,
      explanation: options.explanation ?? 'natural phrasing',
      rule_key: options.ruleKey ?? null,
    },
    recurrence_of_kp_id: options.recurrenceOf ?? null,
    model: 'test-model',
    model_version: 'test-model',
  };
}

/** Writes one knowledge point (with its origin instance and review state). */
export function seedPoint(db: DatabaseType, options: SeedOptions): WriteOutcome {
  return writePath(db, resultFor(options), 'claude-code:UserPromptSubmit', {
    originalText: options.originalText ?? `I need ${options.canonicalForm} in this code.`,
  });
}

export function lastInstanceId(db: DatabaseType): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM instances').get() as { id: number | null };
  if (row.id === null) throw new Error('no instances written');
  return row.id;
}