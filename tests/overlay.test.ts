import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint, lastInstanceId } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting, setLastAnalysisResult, setPreference, setSetting } from '../src/settings.js';
import { STATUSLINE_TTL_MS } from '../src/statusline.js';
import {
  HEARTBEAT_KEY,
  LAST_SHOWN_ID_KEY,
  OVERLAY_FIELD_MAX_COLUMNS,
  POSITION_KEY,
  STATUS_KEY,
  applyHelperMessage,
  nextOverlayMessage,
  overlayStatus,
  parseHelperLine,
  readPosition,
  requestTestOverlay,
} from '../src/overlay.js';

let db: DatabaseType;

beforeEach(() => {
  db = memoryDb();
});

afterEach(() => {
  db.close();
});

/** First poll ever records the cursor without showing anything. */
function prime(): void {
  expect(nextOverlayMessage(db)).toBeNull();
}

describe('overlay: what is new', () => {
  it('does not replay what already existed on the very first poll', () => {
    seedPoint(db, { canonicalForm: 'check whether' });
    prime();
    expect(getSetting(db, LAST_SHOWN_ID_KEY)).toBe(String(lastInstanceId(db)));
    expect(nextOverlayMessage(db)).toBeNull();
  });

  it('shows a suggestion written after the first poll, exactly once', () => {
    prime();
    seedPoint(db, { canonicalForm: 'check whether', rewrite: 'Please check whether it works.', reason: 'word order' });
    const shown = nextOverlayMessage(db);
    expect(shown).toMatchObject({ type: 'show', rewrite: 'Please check whether it works.', reason: 'word order' });
    expect(shown?.label).toBe('Chinglish 搭配');
    expect(nextOverlayMessage(db)).toBeNull();
  });

  it('shows only the newest of several suggestions that landed in one tick', () => {
    prime();
    seedPoint(db, { canonicalForm: 'first', rewrite: 'First.' });
    seedPoint(db, { canonicalForm: 'second', rewrite: 'Second.' });
    expect(nextOverlayMessage(db)?.rewrite).toBe('Second.');
    expect(nextOverlayMessage(db)).toBeNull();
  });

  it('after a restart, still shows a fresh suggestion that arrived while it was down', () => {
    prime();
    seedPoint(db, { canonicalForm: 'while down', rewrite: 'While down.' });
    // A restart keeps the stored cursor, so this is not a first poll.
    expect(nextOverlayMessage(db)?.rewrite).toBe('While down.');
  });

  it('skips a suggestion older than the freshness window but advances past it', () => {
    prime();
    seedPoint(db, { canonicalForm: 'old' });
    const later = new Date(Date.now() + STATUSLINE_TTL_MS + 1000);
    expect(nextOverlayMessage(db, later)).toBeNull();
    expect(getSetting(db, LAST_SHOWN_ID_KEY)).toBe(String(lastInstanceId(db)));
  });

  it('shows nothing in quiet mode and does not pop the backlog when quiet mode ends', () => {
    prime();
    setPreference(db, 'quiet-mode', 'on');
    seedPoint(db, { canonicalForm: 'quiet' });
    expect(nextOverlayMessage(db)).toBeNull();
    setPreference(db, 'quiet-mode', 'off');
    expect(nextOverlayMessage(db)).toBeNull();
  });

  it('shows an analysis failure once per failure', () => {
    prime();
    const at = new Date().toISOString();
    setLastAnalysisResult(db, { outcome: 'failed', at, reason: 'not_configured' });
    expect(nextOverlayMessage(db)?.rewrite).toBe('analysis unavailable');
    expect(nextOverlayMessage(db)).toBeNull();
    setLastAnalysisResult(db, { outcome: 'failed', at: new Date(Date.parse(at) + 5000).toISOString(), reason: 'http_error' });
    expect(nextOverlayMessage(db)?.rewrite).toBe('analysis unavailable');
  });

  it('shows the sample on a test request, even before the first poll, and only once', () => {
    requestTestOverlay(db);
    expect(nextOverlayMessage(db)?.rewrite).toBe('Please check whether this code has a bug.');
    expect(nextOverlayMessage(db)).toBeNull();
  });
});

describe('overlay: payload', () => {
  it('drops the reason of a translation, as the status line does', () => {
    prime();
    seedPoint(db, { canonicalForm: 'translate', issueClass: 'chinese_translation', rewrite: 'Rename it.', reason: 'translated' });
    expect(nextOverlayMessage(db)).toMatchObject({ label: '中文→英文', reason: '' });
  });

  it('strips control characters and caps every field', () => {
    prime();
    seedPoint(db, {
      canonicalForm: 'long',
      rewrite: `bad\u001b[31m red\u0007 ${'x'.repeat(OVERLAY_FIELD_MAX_COLUMNS * 2)}`,
    });
    const shown = nextOverlayMessage(db)!;
    expect(shown.rewrite).not.toMatch(/[\u0000-\u001f]/);
    expect(shown.rewrite.startsWith('bad red')).toBe(true);
    expect(shown.rewrite.length).toBeLessThanOrEqual(OVERLAY_FIELD_MAX_COLUMNS);
    expect(shown.rewrite.endsWith('…')).toBe(true);
  });

  it('carries the configured duration and the stored position', () => {
    prime();
    setPreference(db, 'overlay-duration', '30');
    applyHelperMessage(db, { type: 'moved', x: 120, y: 840 });
    seedPoint(db, { canonicalForm: 'dur' });
    expect(nextOverlayMessage(db)).toMatchObject({ durationMs: 30_000, position: { x: 120, y: 840 } });
  });

  it('defaults to 12 seconds and no position', () => {
    prime();
    seedPoint(db, { canonicalForm: 'dur' });
    expect(nextOverlayMessage(db)).toMatchObject({ durationMs: 12_000, position: null });
  });

  it('rejects durations outside the allowed list', () => {
    expect(setPreference(db, 'overlay-duration', '5').ok).toBe(false);
    expect(setPreference(db, 'overlay-duration', '60').ok).toBe(true);
  });
});

describe('overlay: helper messages', () => {
  it('parses moved and dismissed', () => {
    expect(parseHelperLine('{"type":"moved","x":1.5,"y":-20}')).toEqual({ type: 'moved', x: 1.5, y: -20 });
    expect(parseHelperLine('{"type":"dismissed"}')).toEqual({ type: 'dismissed' });
  });

  it('ignores garbage, partial lines and wrong shapes', () => {
    for (const line of ['', 'not json', '{"type":"moved","x":1', '{"type":"moved","x":"1","y":2}', '{"type":"moved","x":1}', 'null', '[]', '{"type":"other"}']) {
      expect(parseHelperLine(line)).toBeNull();
    }
  });

  it('stores a moved position and ignores a corrupted stored one', () => {
    applyHelperMessage(db, { type: 'moved', x: 10, y: 20 });
    expect(readPosition(db)).toEqual({ x: 10, y: 20 });
    setSetting(db, POSITION_KEY, '{"x":"a"}');
    expect(readPosition(db)).toBeNull();
  });
});

describe('overlay: status', () => {
  it('is not_installed without a LaunchAgent, whatever was recorded', () => {
    setSetting(db, STATUS_KEY, 'running');
    expect(overlayStatus(db, false)).toBe('not_installed');
  });

  it('is running only with a recent heartbeat', () => {
    const now = new Date();
    setSetting(db, STATUS_KEY, 'running');
    setSetting(db, HEARTBEAT_KEY, now.toISOString());
    expect(overlayStatus(db, true, now)).toBe('running');
    expect(overlayStatus(db, true, new Date(now.getTime() + 31_000))).toBe('stopped');
  });

  it('is stopped once the supervisor gave up', () => {
    setSetting(db, STATUS_KEY, 'stopped');
    setSetting(db, HEARTBEAT_KEY, new Date().toISOString());
    expect(overlayStatus(db, true)).toBe('stopped');
  });
});
