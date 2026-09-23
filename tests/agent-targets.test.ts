import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb, resultFor } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting, setSetting } from '../src/settings.js';
import { runInstall, runUninstall, verifyAgentHookConfig, verifyPiExtension } from '../src/install.js';
import { handleUserPromptSubmit } from '../src/hook.js';
import { StubAnalysisClient } from '../src/analysis/stub.js';
import { agentTargetPath } from '../src/cli.js';

let db: DatabaseType;
let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  db = memoryDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refluent-agents-'));
  for (const key of ['REFLUENT_CODEX_SETTINGS', 'REFLUENT_PI_EXTENSIONS', 'REFLUENT_CLAUDE_SETTINGS']) {
    saved[key] = process.env[key];
  }
  process.env.REFLUENT_CODEX_SETTINGS = path.join(tmpDir, 'codex', 'hooks.json');
  process.env.REFLUENT_PI_EXTENSIONS = path.join(tmpDir, 'pi', 'extensions');
  process.env.REFLUENT_CLAUDE_SETTINGS = path.join(tmpDir, 'claude', 'settings.json');
});

afterEach(() => {
  db.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('install: each agent gets a target that fits its platform', () => {
  it('resolves the Codex hooks file against CODEX_HOME, not the literal ~/.codex', () => {
    // A manager like Orca runs Codex with a per-account home; ~/.codex is never read.
    process.env.CODEX_HOME = path.join(tmpDir, 'orca-home');
    delete process.env.REFLUENT_CODEX_SETTINGS;
    expect(agentTargetPath('codex')).toBe(path.join(tmpDir, 'orca-home', 'hooks.json'));
    delete process.env.CODEX_HOME;
    expect(agentTargetPath('codex')).toBe(path.join(os.homedir(), '.codex', 'hooks.json'));
    process.env.REFLUENT_CODEX_SETTINGS = path.join(tmpDir, 'codex', 'hooks.json');
    expect(agentTargetPath('codex')).toBe(path.join(tmpDir, 'codex', 'hooks.json'));
  });

  it('resolves the right path per agent', () => {
    expect(agentTargetPath('claude-code')).toBe(process.env.REFLUENT_CLAUDE_SETTINGS);
    expect(agentTargetPath('codex')).toBe(process.env.REFLUENT_CODEX_SETTINGS);
    expect(agentTargetPath('pi')).toBe(process.env.REFLUENT_PI_EXTENSIONS);
  });

  it('writes Codex hooks in its own file, with no statusLine and other hooks kept', async () => {
    const hooksPath = process.env.REFLUENT_CODEX_SETTINGS!;
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: '/opt/mine.sh' }] }] } }),
      'utf8',
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const report = await runInstall(db, {
      consent: true,
      settingsPath: hooksPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/x/bin/refluent',
      env: { REFLUENT_MODEL_ENDPOINT: 'http://127.0.0.1:9/v1', REFLUENT_MODEL: 'm' },
      agent: 'codex',
    });

    expect(report.installed).toBe(true);
    const saved = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as any;
    expect(JSON.stringify(saved.hooks.UserPromptSubmit)).toContain('--agent codex');
    expect(JSON.stringify(saved.hooks.SessionStart)).toContain('--agent codex');
    // Codex has no injectable status line, so we must not write one.
    expect('statusLine' in saved).toBe(false);
    expect(JSON.stringify(saved.hooks.PostToolUse)).toContain('/opt/mine.sh');
    expect(verifyAgentHookConfig(hooksPath, 'codex')).toBe(true);
    expect(fs.existsSync(`${hooksPath}.refluent-backup`)).toBe(true);
    // The message tells the user where suggestions will appear instead.
    expect(report.messages.join('\n')).toContain('no status line');
  });

  it('uninstall removes only the refluent Codex entries', async () => {
    const hooksPath = process.env.REFLUENT_CODEX_SETTINGS!;
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: '/opt/mine.sh' }] }] } }),
      'utf8',
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await runInstall(db, {
      consent: true,
      settingsPath: hooksPath,
      nodePath: 'node',
      binPath: '/x/bin/refluent',
      env: {},
      agent: 'codex',
    });

    runUninstall(db, hooksPath, 'codex');
    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as any;
    expect(JSON.stringify(after)).not.toContain('refluent');
    expect(JSON.stringify(after.hooks.PostToolUse)).toContain('/opt/mine.sh');
    expect('statusLine' in after).toBe(false);
    expect(getSetting(db, 'hook_installed')).toBe('false');
  });

  it('writes and removes the Pi extension instead of a hook file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const extensionsDir = process.env.REFLUENT_PI_EXTENSIONS!;

    const report = await runInstall(db, {
      consent: true,
      settingsPath: extensionsDir,
      nodePath: '/usr/local/bin/node',
      binPath: '/x/bin/refluent',
      env: {},
      agent: 'pi',
    });

    expect(report.installed).toBe(true);
    expect(verifyPiExtension(extensionsDir)).toBe(true);
    const source = fs.readFileSync(path.join(extensionsDir, 'refluent.ts'), 'utf8');
    expect(source).toContain('before_agent_start');
    expect(source).toContain('setStatus');
    expect(source).toContain('/x/bin/refluent');
    expect(source).toContain('"--agent", "pi"');
    expect(report.messages.join('\n')).toContain('Restart Pi');

    runUninstall(db, extensionsDir, 'pi');
    expect(verifyPiExtension(extensionsDir)).toBe(false);
    expect(fs.existsSync(path.join(extensionsDir, 'refluent.ts'))).toBe(false);
  });
});

describe('capture: the agent decides the recorded origin', () => {
  it('records a Pi capture as pi:before-agent-start', async () => {
    setSetting(db, 'hook_installed', 'true');
    await handleUserPromptSubmit(
      JSON.stringify({ prompt: 'Can you help me check this bug?', session_id: 'pi-1' }),
      { db, agent: 'pi', inlineAnalysis: true, client: new StubAnalysisClient(() => resultFor({ canonicalForm: 'look into' })) },
    );
    const row = db.prepare('SELECT source FROM instances ORDER BY id DESC LIMIT 1').get() as { source: string };
    expect(row.source).toBe('pi:before-agent-start');
  });

  it('still records a Claude Code capture as claude-code:UserPromptSubmit by default', async () => {
    setSetting(db, 'hook_installed', 'true');
    await handleUserPromptSubmit(
      JSON.stringify({ prompt: 'Can you help me check this bug?' }),
      { db, inlineAnalysis: true, client: new StubAnalysisClient(() => resultFor({ canonicalForm: 'look into' })) },
    );
    const row = db.prepare('SELECT source FROM instances ORDER BY id DESC LIMIT 1').get() as { source: string };
    expect(row.source).toBe('claude-code:UserPromptSubmit');
  });
});
