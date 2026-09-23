import type { DatabaseType } from './db.js';
import { getLastAnalysisResult, getSetting, quietModeOn } from './settings.js';
import { issueClassLabel, isIssueClass } from './issue-classes.js';

export interface Suggestion {
  instanceId: number;
  original: string;
  rewrite: string;
  reason: string;
  issueClass: string | null;
  createdAt: string;
}

/**
 * Per-field caps. The status line is a glanceable one-line summary, so no field may grow
 * without bound: a long rewrite or reason would push the rewrite itself off a narrow
 * terminal, which is the one thing the suggestion exists to show. Together the caps keep
 * the whole line bounded (worst case 250 chars for the widest label, before the terminal
 * wraps it).
 */
const MAX_ORIGINAL_CHARS = 80;
const MAX_REWRITE_CHARS = 80;
const MAX_REASON_CHARS = 60;

/** A suggestion or failure notice is shown for this long after it was produced. */
export const STATUSLINE_TTL_MS = 15 * 60 * 1000;

function isFresh(at: string, now: Date): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && now.getTime() - t <= STATUSLINE_TTL_MS;
}

/** The latest stored suggestion, if any. Read-only; it never triggers analysis. */
export function latestSuggestion(db: DatabaseType): Suggestion | null {
  const row = db
    .prepare(
      `SELECT id, original_text, rewrite_text, reason, issue_class, created_at
         FROM instances
        WHERE issue_class IS NOT NULL AND rewrite_text IS NOT NULL AND rewrite_text <> ''
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        original_text: string;
        rewrite_text: string;
        reason: string | null;
        issue_class: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    instanceId: row.id,
    original: row.original_text,
    rewrite: row.rewrite_text,
    reason: row.reason ?? '',
    issueClass: row.issue_class,
    createdAt: row.created_at,
  };
}

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  let cut = oneLine.slice(0, limit - 1);
  // Never emit half a redaction placeholder. `[code]` is the filter's visible marker, so a
  // truncation that lands inside it would print `[c…`, which reads as corruption rather
  // than as a placeholder. Drop an unterminated token before adding the ellipsis.
  const open = cut.lastIndexOf('[');
  if (open !== -1 && cut.indexOf(']', open) === -1) cut = cut.slice(0, open);
  return `${cut.trimEnd()}…`;
}

/**
 * A single plain-text line: original -> rewrite (why). Returns an empty string
 * when there is nothing to show, so the caller leaves the status line untouched.
 * Respects quiet mode and the statusLine switch; no color, no control sequences.
 */
export function renderStatusline(db: DatabaseType, now: Date = new Date()): string {
  if (quietModeOn(db)) return '';
  if ((getSetting(db, 'statusline-suggestion') ?? 'on') !== 'on') return '';

  const suggestion = latestSuggestion(db);
  if (!suggestion || !isFresh(suggestion.createdAt, now)) {
    const last = getLastAnalysisResult(db);
    if (last?.outcome === 'failed' && isFresh(last.at, now)) {
      return 'refluent: analysis unavailable (run `refluent settings`)';
    }
    return '';
  }
  const label = isIssueClass(suggestion.issueClass)
    ? issueClassLabel(suggestion.issueClass)
    : 'issue';
  const reason = truncate(suggestion.reason, MAX_REASON_CHARS);
  const why = reason.length > 0 ? `${label}: ${reason}` : label;
  return `refluent: ${truncate(suggestion.original, MAX_ORIGINAL_CHARS)} → ${truncate(
    suggestion.rewrite,
    MAX_REWRITE_CHARS,
  )} (${why})`;
}