import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { setPreference, setSetting } from '../src/settings.js';
import {
  handleSessionStart,
  handleStatusline,
  handleUserPromptSubmit,
  type HookDeps,
} from '../src/hook.js';
import { StubAnalysisClient } from '../src/analysis/stub.js';
import type { AnalysisResult } from '../src/issue-classes.js';

let db: DatabaseType;

beforeEach(() => {
  db = memoryDb();
  setSetting(db, 'hook_installed', 'true');
});

afterEach(() => {
  db.close();
});

function deps(overrides: Partial<HookDeps> = {}): HookDeps {
  return { db, client: new StubAnalysisClient(() => null), spawnDetached: () => {}, ...overrides };
}

const prompt = [
  'Can you help me look this bug?',
  '',
  '```ts',
  'const token = readToken();',
  '```',
  '',
  '这里 is mixed language.',
].join('\n');

const input = JSON.stringify({ prompt, message_id: 'evt-1', session_id: 's-1' });

describe('hook: the outgoing agent message is passed through byte-for-byte', () => {
  it('writes nothing to stdout and returns 0 for a captured message', async () => {
    const result = await handleUserPromptSubmit(input, deps());
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.captured).toBe(true);
    expect(result.queued).toBe(true);
  });

  it('stores the prompt exactly as captured, without mutation', async () => {
    await handleUserPromptSubmit(input, deps());
    const row = db
      .prepare('SELECT raw_text, filtered_text, status FROM analysis_jobs WHERE message_id = ?')
      .get('evt-1') as { raw_text: string; filtered_text: string; status: string };
    expect(row.raw_text).toBe(prompt);
    expect(Buffer.from(row.raw_text, 'utf8').equals(Buffer.from(prompt, 'utf8'))).toBe(true);
    // Only the filtered text may leave the machine; the code block is gone.
    expect(row.filtered_text).not.toContain('readToken');
  });

  it('keeps stdout empty even when analysis succeeds inline', async () => {
    const analysisResult: AnalysisResult = {
      issue: { class: 'chinese_code_mixing', severity: 'high', span: '这里', explanation: 'mixed' },
      rewrite: 'This part mixes Chinese and English.',
      reason: 'use English',
      knowledge_point: {
        kind: 'expression-unit',
        canonical_form: 'mixed language',
        explanation: 'keep one language',
        rule_key: null,
      },
      recurrence_of_kp_id: null,
    };
    const result = await handleUserPromptSubmit(
      input,
      deps({ client: new StubAnalysisClient(() => analysisResult), inlineAnalysis: true }),
    );
    expect(result.stdout).toBe('');
    expect(db.prepare("SELECT status FROM analysis_jobs WHERE message_id='evt-1'").get()).toEqual({
      status: 'done',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM instances').get()).toEqual({ n: 1 });
    const stored = db.prepare('SELECT original_text FROM instances').get() as { original_text: string };
    const job = db.prepare("SELECT filtered_text FROM analysis_jobs WHERE message_id='evt-1'").get() as {
      filtered_text: string;
    };
    expect(stored.original_text).toBe(job.filtered_text);
    expect(stored.original_text).not.toContain('readToken');
  });

  it('keeps stdout empty and writes nothing when analysis fails', async () => {
    const failing = new StubAnalysisClient(() => {
      throw new Error('model timeout');
    });
    const result = await handleUserPromptSubmit(input, deps({ client: failing, inlineAnalysis: true }));
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(db.prepare("SELECT status FROM analysis_jobs WHERE message_id='evt-1'").get()).toEqual({
      status: 'failed',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM instances').get()).toEqual({ n: 0 });
  });

  it('handles malformed hook input silently', async () => {
    const result = await handleUserPromptSubmit('not json at all', deps());
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.captured).toBeFalsy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 0 });
  });

  it('captures nothing when the user turned capture off', async () => {
    setPreference(db, 'capture-enabled', 'off');
    const result = await handleUserPromptSubmit(input, deps());
    expect(result.stdout).toBe('');
    expect(result.captured).toBeFalsy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 0 });
  });

  it('spawns detached analysis without awaiting it', async () => {
    const spawnDetached = vi.fn();
    const result = await handleUserPromptSubmit(input, deps({ spawnDetached }));
    expect(result.queued).toBe(true);
    expect(spawnDetached).toHaveBeenCalledWith(result.jobId);
  });
});

describe('hook: status line is read-only and one line', () => {
  it('renders the latest stored suggestion without triggering analysis', async () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'Can you help me look this bug?' });
    const result = await handleStatusline('{}', deps());
    expect(result.stdout.startsWith('refluent: ')).toBe(true);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get()).toEqual({ n: 0 });
  });

  it('renders nothing when quiet mode is on', async () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'Can you help me look this bug?' });
    setPreference(db, 'quiet-mode', 'on');
    const result = await handleStatusline('{}', deps());
    expect(result.stdout).toBe('');
  });
});

describe('hook: session start notifies the user, never the agent', () => {
  it('emits a JSON systemMessage with only a count, and calls no model', async () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'secret sentence one', issueClass: 'grammar_error' });
    seedPoint(db, { canonicalForm: 'walk through', originalText: 'secret sentence two', issueClass: 'grammar_error' });
    const client = new StubAnalysisClient(() => null);
    const result = await handleSessionStart('{}', deps({ client }));
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['systemMessage']);
    expect(payload.systemMessage).toContain('2 review item(s)');
    expect(payload.systemMessage).toContain('refluent review');
    expect(result.stdout).not.toContain('secret sentence');
    expect(client.calls.generateQuestion).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_questions').get()).toEqual({ n: 0 });
  });

  it('prints nothing when no knowledge point is due', async () => {
    const result = await handleSessionStart('{}', deps());
    expect(result.stdout).toBe('');
  });
});

describe('hook: liveness is recorded by the hook process itself', () => {
  it('marks the hook seen whenever Claude Code runs the capture hook', async () => {
    const { hookStatus } = await import('../src/settings.js');
    expect(hookStatus(db)).toBe('installed_not_loaded');
    await handleUserPromptSubmit(input, deps());
    expect(hookStatus(db)).toBe('installed_and_loaded');
  });
});