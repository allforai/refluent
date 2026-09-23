import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting, setLastAnalysisResult, setSetting } from '../src/settings.js';
import { renderStatusline, STATUSLINE_TTL_MS } from '../src/statusline.js';
import { handleStatusline } from '../src/hook.js';
import { runInstall, runUninstall, WRAPPED_STATUSLINE_KEY } from '../src/install.js';

let db: DatabaseType;
let tmpDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  db = memoryDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refluent-statusline-'));
  savedDataDir = process.env.REFLUENT_DATA_DIR;
  process.env.REFLUENT_DATA_DIR = path.join(tmpDir, 'data');
});

afterEach(() => {
  db.close();
  if (savedDataDir === undefined) delete process.env.REFLUENT_DATA_DIR;
  else process.env.REFLUENT_DATA_DIR = savedDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('statusline: suggestions expire', () => {
  it('shows a fresh suggestion and hides it once it is older than the TTL', () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'Can you help me look this bug?' });
    expect(renderStatusline(db)).toContain('refluent: ');
    const later = new Date(Date.now() + STATUSLINE_TTL_MS + 1000);
    expect(renderStatusline(db, later)).toBe('');
  });

  it('tells the user when analysis recently failed and there is nothing fresh to show', () => {
    setLastAnalysisResult(db, { outcome: 'failed', at: new Date().toISOString(), reason: 'analysis_unavailable' });
    expect(renderStatusline(db)).toBe('refluent: analysis unavailable (run `refluent settings`)');
  });
});

describe('statusline: an existing statusLine is kept, not replaced', () => {
  const orca = { type: 'command', command: '/opt/orca/statusline.sh', padding: 0 };

  function settingsWithOrca(): string {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: orca, model: 'opus' }), 'utf8');
    return settingsPath;
  }

  it('install wraps the previous statusLine, backs up the file, and keeps other keys', async () => {
    const settingsPath = settingsWithOrca();
    await runInstall(db, { consent: true, settingsPath, nodePath: 'node', binPath: '/x/bin/refluent', env: {} });

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    expect(saved.statusLine.command).toContain('refluent');
    expect(saved.model).toBe('opus');
    expect(JSON.parse(getSetting(db, WRAPPED_STATUSLINE_KEY)!)).toEqual(orca);
    expect(JSON.parse(fs.readFileSync(`${settingsPath}.refluent-backup`, 'utf8')).statusLine).toEqual(orca);
  });

  it('runs the wrapped command with the hook input and prints its output above the refluent line', async () => {
    setSetting(db, WRAPPED_STATUSLINE_KEY, JSON.stringify(orca));
    seedPoint(db, { canonicalForm: 'look into', originalText: 'Can you help me look this bug?' });
    const seen: Array<[string, string]> = [];
    const result = await handleStatusline('{"model":"x"}', {
      db,
      runStatusCommand: (command, input) => {
        seen.push([command, input]);
        return 'orca: main ✓\n';
      },
    });
    expect(seen).toEqual([['/opt/orca/statusline.sh', '{"model":"x"}']]);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('orca: main ✓');
    expect(lines[1].startsWith('refluent: ')).toBe(true);
  });

  it('uninstall removes every refluent entry and restores the previous statusLine', async () => {
    const settingsPath = settingsWithOrca();
    await runInstall(db, { consent: true, settingsPath, nodePath: 'node', binPath: '/x/bin/refluent', env: {} });
    runUninstall(db, settingsPath);

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    expect(JSON.stringify(saved)).not.toContain('refluent');
    expect(saved.statusLine).toEqual(orca);
    expect(saved.model).toBe('opus');
    expect(getSetting(db, 'hook_installed')).toBe('false');
  });
});

describe('uninstall: a settings file returns to what the user had', () => {
  function writeSettings(value: Record<string, unknown>): string {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return settingsPath;
  }

  it('leaves no empty hooks object behind when the user had no hooks key', async () => {
    const original = { statusLine: { type: 'command', command: '/opt/orca/statusline.sh' }, model: 'opus' };
    const settingsPath = writeSettings(original);
    await runInstall(db, { consent: true, settingsPath, nodePath: 'node', binPath: '/x/bin/refluent', env: {} });
    runUninstall(db, settingsPath);

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(saved).toEqual(original);
    expect('hooks' in saved).toBe(false);
  });

  it('keeps the hooks the user already had', async () => {
    const theirs = { hooks: [{ hooks: [{ type: 'command', command: '/opt/mine/notify.sh' }] }] };
    const original = { hooks: { PostToolUse: theirs.hooks, UserPromptSubmit: theirs.hooks }, model: 'opus' };
    const settingsPath = writeSettings(original);
    await runInstall(db, { consent: true, settingsPath, nodePath: 'node', binPath: '/x/bin/refluent', env: {} });
    runUninstall(db, settingsPath);

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    expect(saved.hooks.PostToolUse).toEqual(theirs.hooks);
    expect(saved.hooks.UserPromptSubmit).toEqual(theirs.hooks);
    expect(JSON.stringify(saved)).not.toContain('refluent');
  });
});

describe('statusline: the line stays bounded so the rewrite keeps its place', () => {
  it('caps a long original, rewrite and reason', () => {
    seedPoint(db, {
      canonicalForm: 'look into',
      originalText: `${'x'.repeat(200)} src/db.ts and parseArgs()`,
      rewrite: 'y'.repeat(200),
      reason: 'z'.repeat(200),
    });

    const line = renderStatusline(db);
    expect(line.startsWith('refluent: ')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(250);
    expect(line).toContain('…');
    // The rewrite is still present, not pushed off the end by the other two fields.
    expect(line).toContain('yyyy');
  });

  it('never prints half a redaction placeholder when the cut lands inside [code]', () => {
    seedPoint(db, {
      canonicalForm: 'look into',
      originalText: `${'[code] and '.repeat(12)}end`,
      rewrite: 'Keep the sentence natural.',
      reason: 'Chinglish.',
    });

    const line = renderStatusline(db);
    const opened = (line.match(/\[/g) ?? []).length;
    const complete = (line.match(/\[code\]/g) ?? []).length;
    expect(opened).toBe(complete);
    expect(line).not.toMatch(/\[c…/);
  });

  it('leaves a short suggestion byte-identical', () => {
    seedPoint(db, {
      canonicalForm: 'look into',
      originalText: 'Can you help me look this bug?',
      rewrite: 'Can you look into this bug?',
      reason: 'natural verb',
    });

    expect(renderStatusline(db)).toBe(
      'refluent: Can you help me look this bug? → Can you look into this bug? (Chinglish 搭配: natural verb)',
    );
  });
});
