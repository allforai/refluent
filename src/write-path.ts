import { nowIso } from './config.js';
import type { DatabaseType } from './db.js';
import type { AnalysisResult, KnowledgePointKind } from './issue-classes.js';

export type WriteSource = 'claude-code:UserPromptSubmit' | 'refluent:review' | 'refluent:manual';
export type LinkRole = 'origin' | 'recurrence' | 'review';

export interface WriteJob {
  analysisJobId?: number | null;
  originalText: string;
  messageId?: string | null;
  sessionId?: string | null;
  model?: string | null;
  modelVersion?: string | null;
  filterVersion?: string | null;
}

export interface WriteOutcome {
  written: boolean;
  reason?: 'no_issue' | 'missing_knowledge_point' | 'canonical_form_length';
  instanceId?: number;
  knowledgePointId?: number;
  role?: LinkRole;
  createdKnowledgePoint?: boolean;
  matchKey?: string;
}

const MATCH_KEY_MIN = 2;
const MATCH_KEY_MAX = 200;
const JACCARD_THRESHOLD = 0.6;

/** NFC, lowercase, collapsed whitespace, punctuation stripped except internal apostrophes/hyphens. */
export function normalizeCanonical(form: string): string {
  return form
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/[^\p{L}\p{N}\s'\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchKey(kind: KnowledgePointKind, canonicalForm: string): string {
  return `${kind}:${normalizeCanonical(canonicalForm)}`;
}

export function tokenJaccard(a: string, b: string): number {
  const left = new Set(normalizeCanonical(a).split(' ').filter(Boolean));
  const right = new Set(normalizeCanonical(b).split(' ').filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * One transaction: instance insert + knowledge-point insert-or-link + review-state
 * upsert. `issue=null`, a missing knowledge point, or an out-of-range canonical
 * form writes nothing.
 */
export function writePath(
  db: DatabaseType,
  result: AnalysisResult,
  source: WriteSource,
  job: WriteJob,
): WriteOutcome {
  if (!result.issue || !result.knowledge_point) {
    return { written: false, reason: result.issue ? 'missing_knowledge_point' : 'no_issue' };
  }
  // Bind the narrowed fields once: TypeScript does not carry the guard's
  // narrowing into the nested transaction closure below.
  const issue = result.issue;
  const knowledgePoint = result.knowledge_point;
  const canonical = knowledgePoint.canonical_form.trim();
  if (canonical.length < MATCH_KEY_MIN || canonical.length > MATCH_KEY_MAX) {
    return { written: false, reason: 'canonical_form_length' };
  }

  const kind = knowledgePoint.kind;
  const key = matchKey(kind, canonical);
  const at = nowIso();

  const run = db.transaction((): WriteOutcome => {
    let knowledgePointId: number | null = null;
    let role: LinkRole = source === 'refluent:review' ? 'review' : 'origin';
    let createdKnowledgePoint = false;

    const exact = db.prepare('SELECT id FROM knowledge_points WHERE match_key = ?').get(key) as
      | { id: number }
      | undefined;
    if (exact) {
      knowledgePointId = exact.id;
      role = source === 'refluent:review' ? 'review' : 'recurrence';
    } else if (result.recurrence_of_kp_id !== null) {
      const candidate = db
        .prepare('SELECT id, canonical_form FROM knowledge_points WHERE id = ? AND kind = ?')
        .get(result.recurrence_of_kp_id, kind) as { id: number; canonical_form: string } | undefined;
      if (candidate && tokenJaccard(canonical, candidate.canonical_form) >= JACCARD_THRESHOLD) {
        knowledgePointId = candidate.id;
        role = source === 'refluent:review' ? 'review' : 'recurrence';
      }
    }

    const insertInstance = db.prepare(
      `INSERT INTO instances
        (analysis_job_id, original_text, rewrite_text, reason, issue_class, created_at,
         source, message_id, session_id, model, model_version, filter_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const instanceResult = insertInstance.run(
      job.analysisJobId ?? null,
      job.originalText,
      result.rewrite,
      result.reason,
      issue.class,
      at,
      source,
      job.messageId ?? null,
      job.sessionId ?? null,
      job.model ?? result.model ?? null,
      job.modelVersion ?? result.model_version ?? null,
      job.filterVersion ?? null,
    );
    const instanceId = Number(instanceResult.lastInsertRowid);

    if (knowledgePointId === null) {
      createdKnowledgePoint = true;
      const kpResult = db
        .prepare(
          `INSERT INTO knowledge_points
            (kind, canonical_form, match_key, rule_key, explanation, occurrence_count,
             first_instance_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'active', ?, ?)`,
        )
        .run(
          kind,
          canonical,
          key,
          knowledgePoint.rule_key,
          knowledgePoint.explanation,
          instanceId,
          at,
          at,
        );
      knowledgePointId = Number(kpResult.lastInsertRowid);
      db.prepare(
        `INSERT INTO review_states
          (knowledge_point_id, due_at, state, stability, difficulty, reps, lapses,
           last_review_at, last_rating, scheduler, created_at, updated_at)
         VALUES (?, ?, 'new', NULL, NULL, 0, 0, NULL, NULL, 'fsrs-5', ?, ?)`,
      ).run(knowledgePointId, at, at, at);
    } else {
      db.prepare(
        `UPDATE knowledge_points
            SET occurrence_count = occurrence_count + 1, updated_at = ?
          WHERE id = ?`,
      ).run(at, knowledgePointId);
      db.prepare(
        `UPDATE knowledge_points
            SET first_instance_id = COALESCE(first_instance_id, ?)
          WHERE id = ?`,
      ).run(instanceId, knowledgePointId);
    }

    db.prepare(
      `INSERT OR IGNORE INTO instance_knowledge_points
        (instance_id, knowledge_point_id, role, linked_at)
       VALUES (?, ?, ?, ?)`,
    ).run(instanceId, knowledgePointId, role, at);

    return {
      written: true,
      instanceId,
      knowledgePointId,
      role,
      createdKnowledgePoint,
      matchKey: key,
    };
  });

  return run();
}