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

/** ANSI escape sequences and control characters: the line must never drive the terminal. */
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Display width in terminal columns. A CJK glyph occupies two columns, so a
 * length-based budget would over-run the pane exactly where this product shows
 * its Chinese issue labels — which is how a suggestion ends up cut mid-word.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 0x1100) return 1;
  for (const [from, to] of WIDE_RANGES) {
    if (codePoint >= from && codePoint <= to) return 2;
  }
  return 1;
}

/** Columns a string occupies, ignoring control characters. */
export function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char.codePointAt(0) ?? 0);
  return total;
}

function sanitizeOneLine(text: string): string {
  return text
    .replace(ANSI_CSI_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts to a column budget, protecting `[code]` and marking the cut with `…`. */
function cutToWidth(text: string, maxColumns: number): string {
  const oneLine = sanitizeOneLine(text);
  if (displayWidth(oneLine) <= maxColumns) return oneLine;
  if (maxColumns <= 1) return '';
  let cut = '';
  let used = 0;
  for (const char of oneLine) {
    const width = charWidth(char.codePointAt(0) ?? 0);
    if (used + width > maxColumns - 1) break;
    cut += char;
    used += width;
  }
  // Never emit half a redaction placeholder. `[code]` is the filter's visible marker, so a
  // truncation that lands inside it would print `[c…`, which reads as corruption rather
  // than as a placeholder. Drop an unterminated token before adding the ellipsis.
  const open = cut.lastIndexOf('[');
  if (open !== -1 && cut.indexOf(']', open) === -1) cut = cut.slice(0, open);
  // Prefer a word boundary when one is close, so a cut reads as "(Chinese mixed with…)"
  // rather than "(Chinese mixed with Engli…)".
  const space = cut.lastIndexOf(' ');
  if (space > 0 && cut.length - space <= Math.max(4, Math.ceil(cut.length * 0.25))) {
    cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

function truncate(text: string, limit: number): string {
  return cutToWidth(text, limit);
}

const PREFIX = 'refluent: ';
/** Claude Code reserves a few columns of its own spacing around the status line. */
export const STATUSLINE_TERMINAL_MARGIN = 4;

/** Columns available to a status line in a terminal of this width. */
export function statuslineBudget(terminalColumns: number): number {
  return Math.max(20, Math.floor(terminalColumns) - STATUSLINE_TERMINAL_MARGIN);
}

/**
 * Richness ladder. Each step gives up the least valuable thing that is still on
 * the line: the issue-class label is redundant with the reason, and the user's
 * own sentence is already in the transcript, while the rewrite and the reason
 * are what the suggestion exists to convey. The first step that fits the pane
 * wins, so a narrow terminal loses the original instead of losing the reason.
 */
function renderSuggestion(
  suggestion: Suggestion,
  maxColumns: number | null,
): string {
  const original = truncate(suggestion.original, MAX_ORIGINAL_CHARS);
  const rewrite = truncate(suggestion.rewrite, MAX_REWRITE_CHARS);
  const reason = truncate(suggestion.reason, MAX_REASON_CHARS);
  const label = isIssueClass(suggestion.issueClass) ? issueClassLabel(suggestion.issueClass) : 'issue';
  const why = reason.length > 0 ? `${label}: ${reason}` : label;
  const withReason = reason.length > 0 ? reason : label;

  const ladder = [
    `${PREFIX}${original} → ${rewrite} (${why})`,
    `${PREFIX}${original} → ${rewrite} (${withReason})`,
    `${PREFIX}${rewrite} (${why})`,
    `${PREFIX}${rewrite} (${withReason})`,
  ];
  if (maxColumns === null) return ladder[0]!;
  for (const candidate of ladder) {
    if (displayWidth(candidate) <= maxColumns) return candidate;
  }

  // Nothing fits whole: keep the rewrite readable and spend what is left on the reason.
  const fixed = displayWidth(`${PREFIX} ()`);
  const remaining = Math.max(8, maxColumns - fixed);
  const rewriteBudget = Math.max(8, Math.floor(remaining * 0.5));
  const shortRewrite = cutToWidth(suggestion.rewrite, rewriteBudget);
  const reasonBudget = Math.max(0, maxColumns - displayWidth(`${PREFIX}${shortRewrite} ()`));
  const shortReason = reasonBudget >= 6 ? cutToWidth(withReason, reasonBudget) : '';
  return shortReason ? `${PREFIX}${shortRewrite} (${shortReason})` : `${PREFIX}${shortRewrite}`;
}

/**
 * A single plain-text line: original -> rewrite (why). Returns an empty string
 * when there is nothing to show, so the caller leaves the status line untouched.
 * Respects quiet mode and the statusLine switch; no color, no control sequences.
 *
 * `maxColumns` is the usable width when it could be discovered (see
 * `detectTerminalWidth`); null keeps the bounded-but-unfitted form.
 */
export function renderStatusline(
  db: DatabaseType,
  now: Date = new Date(),
  options: { maxColumns?: number | null } = {},
): string {
  if (quietModeOn(db)) return '';
  if ((getSetting(db, 'statusline-suggestion') ?? 'on') !== 'on') return '';

  const suggestion = latestSuggestion(db);
  if (!suggestion || !isFresh(suggestion.createdAt, now)) {
    const last = getLastAnalysisResult(db);
    if (last?.outcome === 'failed' && isFresh(last.at, now)) {
      return `${PREFIX}analysis unavailable (run \`refluent settings\`)`;
    }
    return '';
  }
  return renderSuggestion(suggestion, options.maxColumns ?? null);
}