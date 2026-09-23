import { randomUUID } from 'node:crypto';
import { nowIso } from './config.js';
import type { DatabaseType } from './db.js';
import { FILTER_VERSION, filterNaturalLanguage, type SkipReason } from './filter.js';
import type { AnalysisClient } from './analysis/types.js';
import { writePath, type WriteSource } from './write-path.js';
import { setLastAnalysisResult } from './settings.js';

export interface CaptureInput {
  rawText: string;
  messageId?: string | null;
  sessionId?: string | null;
  source?: WriteSource;
}

export interface CaptureOutcome {
  jobId: number;
  duplicate: boolean;
  filteredText: string | null;
  skipReason: SkipReason | null;
  /** True when analysis should be run asynchronously off the critical path. */
  queued: boolean;
}

export interface AnalysisJobRow {
  id: number;
  message_id: string;
  session_id: string | null;
  raw_text: string;
  filtered_text: string | null;
  skip_reason: string | null;
  status: string;
}

/**
 * Snapshot an outgoing message and filter it. This never mutates or delays the
 * message itself; the caller has already forwarded it byte-for-byte.
 */
export function captureMessage(db: DatabaseType, input: CaptureInput): CaptureOutcome {
  const messageId = input.messageId && input.messageId.length > 0 ? input.messageId : randomUUID();
  const existing = db.prepare('SELECT id, filtered_text, skip_reason, status FROM analysis_jobs WHERE message_id = ?').get(messageId) as
    | { id: number; filtered_text: string | null; skip_reason: string | null; status: string }
    | undefined;
  if (existing) {
    return {
      jobId: existing.id,
      duplicate: true,
      filteredText: existing.filtered_text,
      skipReason: (existing.skip_reason as SkipReason | null) ?? null,
      queued: existing.status === 'queued',
    };
  }

  const at = nowIso();
  const result = filterNaturalLanguage(input.rawText);
  const insert = db.prepare(
    `INSERT INTO analysis_jobs
      (message_id, session_id, raw_text, filtered_text, skip_reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = insert.run(
    messageId,
    input.sessionId ?? null,
    input.rawText,
    result.filteredText,
    result.skipReason,
    result.skipReason ? 'filtered' : 'queued',
    at,
  );
  const jobId = Number(info.lastInsertRowid);

  if (result.skipReason) {
    db.prepare('UPDATE analysis_jobs SET finished_at = ? WHERE id = ?').run(at, jobId);
    setLastAnalysisResult(db, { outcome: 'skipped_filtered', at, reason: result.skipReason });
    return { jobId, duplicate: false, filteredText: null, skipReason: result.skipReason, queued: false };
  }
  return { jobId, duplicate: false, filteredText: result.filteredText, skipReason: null, queued: true };
}

export interface AnalysisOutcome {
  status: 'done' | 'failed' | 'skipped';
  wrote: boolean;
  reason?: string;
}

/**
 * Runs the model call and write path for one queued job. Failure is silent by
 * design: the job is marked failed and nothing is written.
 */
export async function runAnalysis(
  db: DatabaseType,
  client: AnalysisClient,
  jobId: number,
  source: WriteSource = 'claude-code:UserPromptSubmit',
): Promise<AnalysisOutcome> {
  const job = db
    .prepare(
      'SELECT id, message_id, session_id, raw_text, filtered_text, skip_reason, status FROM analysis_jobs WHERE id = ?',
    )
    .get(jobId) as AnalysisJobRow | undefined;
  if (!job) return { status: 'failed', wrote: false, reason: 'job_not_found' };
  if (job.status !== 'queued' || !job.filtered_text) {
    return { status: 'skipped', wrote: false, reason: `job_status_${job.status}` };
  }

  const startedAt = Date.now();
  db.prepare("UPDATE analysis_jobs SET status = 'running' WHERE id = ?").run(jobId);

  let result;
  try {
    result = await client.analyze({ filteredText: job.filtered_text, filterVersion: FILTER_VERSION });
  } catch {
    result = null;
  }
  const latency = Date.now() - startedAt;
  const finishedAt = nowIso();

  if (!result) {
    // Keep the sanitized cause: "analysis_unavailable" alone made a missing
    // configuration indistinguishable from an HTTP rejection or a timeout.
    const reason = client.lastFailure ?? 'analysis_unavailable';
    db.prepare(
      "UPDATE analysis_jobs SET status = 'failed', error = ?, finished_at = ?, latency_ms = ? WHERE id = ?",
    ).run(reason, finishedAt, latency, jobId);
    setLastAnalysisResult(db, { outcome: 'failed', at: finishedAt, reason });
    return { status: 'failed', wrote: false, reason };
  }

  const outcome = writePath(
    db,
    result,
    source,
    {
      analysisJobId: job.id,
      // Only the filtered text is kept on an instance: it is what the status
      // line and review prompts show, so raw code and logs never resurface.
      originalText: job.filtered_text,
      messageId: job.message_id,
      sessionId: job.session_id,
      filterVersion: FILTER_VERSION,
    },
  );
  db.prepare(
    "UPDATE analysis_jobs SET status = 'done', finished_at = ?, latency_ms = ? WHERE id = ?",
  ).run(finishedAt, latency, jobId);
  setLastAnalysisResult(db, {
    outcome: result.issue ? 'suggestion_emitted' : 'no_improvement',
    at: finishedAt,
    reason: null,
  });
  return { status: 'done', wrote: outcome.written, reason: outcome.reason };
}