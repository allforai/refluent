import type { DatabaseType } from './db.js';
import { nowIso } from './config.js';
import { getLastAnalysisResult, getSetting, quietModeOn, setSetting } from './settings.js';
import { issueClassLabel, isIssueClass } from './issue-classes.js';
import { cutToWidth, isFresh, latestSuggestion, type Suggestion } from './statusline.js';

/**
 * Decisions for the floating overlay. Everything here is synchronous and reads or writes
 * only the settings table, so the process shell (`overlay-runner.ts`) stays dumb and
 * this stays testable against an in-memory database.
 */

/** The panel is wider than a terminal row, but no field may grow without bound. */
export const OVERLAY_FIELD_MAX_COLUMNS = 300;

export const LAST_SHOWN_ID_KEY = 'overlay-last-shown-id';
export const LAST_FAILURE_AT_KEY = 'overlay-last-failure-at';
export const POSITION_KEY = 'overlay-position';
export const TEST_REQUEST_KEY = 'overlay-test-request';
export const STATUS_KEY = 'overlay_status';
export const HEARTBEAT_KEY = 'overlay_heartbeat_at';
/** The runner beats every 10 s; three missed beats means it is not running. */
export const HEARTBEAT_STALE_MS = 30_000;

const DEFAULT_DURATION_SECONDS = 12;

export interface OverlayPosition {
  x: number;
  y: number;
}

export interface ShowMessage {
  type: 'show';
  rewrite: string;
  label: string;
  reason: string;
  original: string;
  durationMs: number;
  position: OverlayPosition | null;
}

export type HelperMessage = { type: 'moved'; x: number; y: number } | { type: 'dismissed' };

export type OverlayStatus = 'running' | 'stopped' | 'not_installed';

const SAMPLE_SUGGESTION: Suggestion = {
  instanceId: 0,
  original: 'Please help me check this code whether has bug.',
  rewrite: 'Please check whether this code has a bug.',
  reason: 'Keep statement order after "whether".',
  issueClass: 'grammar_error',
  createdAt: '',
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function field(text: string): string {
  return cutToWidth(text, OVERLAY_FIELD_MAX_COLUMNS);
}

function durationMs(db: DatabaseType): number {
  const seconds = Number(getSetting(db, 'overlay-duration') ?? DEFAULT_DURATION_SECONDS);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DURATION_SECONDS) * 1000;
}

export function readPosition(db: DatabaseType): OverlayPosition | null {
  const raw = getSetting(db, POSITION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return parsed && isFiniteNumber(parsed.x) && isFiniteNumber(parsed.y) ? { x: parsed.x, y: parsed.y } : null;
  } catch {
    return null;
  }
}

export function buildShowMessage(db: DatabaseType, suggestion: Suggestion): ShowMessage {
  const label = isIssueClass(suggestion.issueClass) ? issueClassLabel(suggestion.issueClass) : 'issue';
  return {
    type: 'show',
    rewrite: field(suggestion.rewrite),
    label,
    // A translation's reason only repeats its label, as on the status line.
    reason: suggestion.issueClass === 'chinese_translation' ? '' : field(suggestion.reason),
    original: field(suggestion.original),
    durationMs: durationMs(db),
    position: readPosition(db),
  };
}

function failureMessage(db: DatabaseType): ShowMessage {
  return {
    type: 'show',
    rewrite: 'analysis unavailable',
    label: 'refluent',
    reason: 'run `refluent settings`',
    original: '',
    durationMs: durationMs(db),
    position: readPosition(db),
  };
}

/** Asks the running overlay to show the sample suggestion on its next poll. */
export function requestTestOverlay(db: DatabaseType, now: Date = new Date()): void {
  setSetting(db, TEST_REQUEST_KEY, nowIso(now));
}

/**
 * What the overlay should show now, if anything. Advances the stored cursors, so each
 * suggestion and each failure is shown at most once — including in quiet mode, where the
 * backlog is skipped rather than replayed when quiet mode ends.
 */
export function nextOverlayMessage(db: DatabaseType, now: Date = new Date()): ShowMessage | null {
  if (getSetting(db, TEST_REQUEST_KEY)) {
    setSetting(db, TEST_REQUEST_KEY, '');
    return buildShowMessage(db, SAMPLE_SUGGESTION);
  }

  const suggestion = latestSuggestion(db);
  const last = getLastAnalysisResult(db);
  const storedId = getSetting(db, LAST_SHOWN_ID_KEY);
  if (!storedId) {
    // First poll ever: what already exists was seen on the status line, not news.
    setSetting(db, LAST_SHOWN_ID_KEY, String(suggestion?.instanceId ?? 0));
    if (last?.outcome === 'failed') setSetting(db, LAST_FAILURE_AT_KEY, last.at);
    return null;
  }

  let message: ShowMessage | null = null;
  if (suggestion && suggestion.instanceId > Number(storedId)) {
    setSetting(db, LAST_SHOWN_ID_KEY, String(suggestion.instanceId));
    if (isFresh(suggestion.createdAt, now)) message = buildShowMessage(db, suggestion);
  }
  if (!message && last?.outcome === 'failed' && last.at !== getSetting(db, LAST_FAILURE_AT_KEY)) {
    setSetting(db, LAST_FAILURE_AT_KEY, last.at);
    if (isFresh(last.at, now)) message = failureMessage(db);
  }
  return quietModeOn(db) ? null : message;
}

/** One line from the helper's stdout; anything malformed is ignored, never thrown. */
export function parseHelperLine(line: string): HelperMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'moved' && isFiniteNumber(record.x) && isFiniteNumber(record.y)) {
    return { type: 'moved', x: record.x, y: record.y };
  }
  if (record.type === 'dismissed') return { type: 'dismissed' };
  return null;
}

export function applyHelperMessage(db: DatabaseType, message: HelperMessage): void {
  if (message.type === 'moved') {
    setSetting(db, POSITION_KEY, JSON.stringify({ x: message.x, y: message.y }));
  }
}

/** `installed` is whether the LaunchAgent exists; the runner records the rest. */
export function overlayStatus(db: DatabaseType, installed: boolean, now: Date = new Date()): OverlayStatus {
  if (!installed) return 'not_installed';
  if (getSetting(db, STATUS_KEY) !== 'running') return 'stopped';
  const beat = Date.parse(getSetting(db, HEARTBEAT_KEY) ?? '');
  return Number.isFinite(beat) && now.getTime() - beat <= HEARTBEAT_STALE_MS ? 'running' : 'stopped';
}
