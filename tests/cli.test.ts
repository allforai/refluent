import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { TEST_REQUEST_KEY } from '../src/overlay.js';
import { performOverlayTest } from '../src/cli.js';

let db: DatabaseType;

beforeEach(() => {
  db = memoryDb();
});

afterEach(() => {
  db.close();
});

describe('cli: overlay test', () => {
  it('does not queue a sample when the overlay is not installed', () => {
    const outcome = performOverlayTest(db, 'not_installed', '/tmp/overlay.log');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('the overlay is not installed; run `refluent overlay install` first.');
    expect(getSetting(db, TEST_REQUEST_KEY)).toBeUndefined();
  });

  it('does not queue a sample when the overlay is stopped, and names the log path', () => {
    const outcome = performOverlayTest(db, 'stopped', '/tmp/overlay.log');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(
      'the overlay is installed but not running; see /tmp/overlay.log, or run `refluent overlay install` again to restart it.',
    );
    expect(getSetting(db, TEST_REQUEST_KEY)).toBeUndefined();
  });

  it('queues a sample only when the overlay is running', () => {
    const outcome = performOverlayTest(db, 'running', '/tmp/overlay.log');
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe('Sent a sample suggestion to the overlay.');
    expect(getSetting(db, TEST_REQUEST_KEY)).toBeTruthy();
  });
});
