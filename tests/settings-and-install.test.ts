import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import {
  effectiveCaptureEnabled,
  hookStatus,
  endpointStatus,
  setPreference,
  getSetting,
  markHookSeen,
  setSetting,
} from '../src/settings.js';
import {
  installSummary,
  probeEndpoint,
  recordEndpointProbe,
  runInstall,
  verifyHookConfig,
  writeHookConfig,
} from '../src/install.js';
import { agentDefinition } from '../src/agents.js';
import { buildSettingsReport } from '../src/cli.js';
import { HEARTBEAT_KEY, STATUS_KEY } from '../src/overlay.js';

let db: DatabaseType;
let tmpDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  db = memoryDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refluent-test-'));
  savedDataDir = process.env.REFLUENT_DATA_DIR;
  process.env.REFLUENT_DATA_DIR = path.join(tmpDir, 'data');
});

afterEach(() => {
  db.close();
  if (savedDataDir === undefined) delete process.env.REFLUENT_DATA_DIR;
  else process.env.REFLUENT_DATA_DIR = savedDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('settings: enablement reflects the real hook state', () => {
  it('is disabled while the hook is not installed, even with the preference on', () => {
    const state = effectiveCaptureEnabled(db);
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe('hook_not_installed');
    expect(hookStatus(db)).toBe('not_installed');
  });

  it('enables capture once installed, but reports installed_not_loaded until the hook runs', () => {
    setSetting(db, 'hook_installed', 'true');
    expect(effectiveCaptureEnabled(db)).toEqual({ enabled: true, reason: 'hook_installed' });
    expect(hookStatus(db)).toBe('installed_not_loaded');
  });

  it('reports installed_and_loaded only after the hook process marked itself seen', () => {
    setSetting(db, 'hook_installed', 'true');
    markHookSeen(db, '2026-09-23T00:00:00.000Z');
    expect(hookStatus(db)).toBe('installed_and_loaded');
  });

  it('an off preference wins over an installed and loaded hook', () => {
    setSetting(db, 'hook_installed', 'true');
    markHookSeen(db);
    setPreference(db, 'capture-enabled', 'off');
    expect(effectiveCaptureEnabled(db).reason).toBe('preference_off');
  });

  it('rejects an invalid preference value without changing stored state', () => {
    const result = setPreference(db, 'quiet-mode', 'maybe');
    expect(result.ok).toBe(false);
    expect(getSetting(db, 'quiet-mode')).toBe('off');
  });

  it('accepts auto/on/off for statusline-original and nothing else', () => {
    expect(setPreference(db, 'statusline-original', 'on').ok).toBe(true);
    expect(setPreference(db, 'statusline-original', 'off').ok).toBe(true);
    expect(setPreference(db, 'statusline-original', 'auto').ok).toBe(true);
    expect(getSetting(db, 'statusline-original')).toBe('auto');

    const rejected = setPreference(db, 'statusline-original', 'yes');
    expect(rejected.ok).toBe(false);
    expect(getSetting(db, 'statusline-original')).toBe('auto');
  });
});

describe('settings: settings report shows real hook and endpoint liveness', () => {
  it('reports hook status, endpoint liveness and capture reason from stored state', () => {
    setSetting(db, 'hook_installed', 'true');
    markHookSeen(db);
    recordEndpointProbe(db, { status: 'ready', error: null, checkedAt: '2026-01-01T00:00:00.000Z' });

    const report = buildSettingsReport(db);
    expect(report.hookStatus).toBe('installed_and_loaded');
    expect(report.endpointStatus).toBe('ready');
    expect(report.captureEnabled).toBe(true);
    expect(report.captureReason).toBe('hook_installed');
  });

  it('endpoint liveness with no environment or stored config is not_configured and never probes the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const probe = await probeEndpoint(db, {});
    expect(probe.status).toBe('not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('classifies a reachable endpoint as ready and an unreachable one as unreachable', async () => {
    const env = { REFLUENT_MODEL_ENDPOINT: 'http://localhost:9/v1', REFLUENT_MODEL: 'small-model' };

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect((await probeEndpoint(db, env)).status).toBe('ready');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }));
    const down = await probeEndpoint(db, env);
    expect(down.status).toBe('unreachable');
    expect(down.error).toContain('ECONNREFUSED');
    vi.unstubAllGlobals();

    recordEndpointProbe(db, down);
    expect(endpointStatus(db)).toBe('unreachable');
  });
});

describe('install: authorization, hook file and loaded state', () => {
  it('declined consent writes no hook and leaves capture off', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    const report = await runInstall(db, {
      consent: false,
      settingsPath,
      binPath: '/tmp/bin/refluent',
      env: {},
    });
    expect(report.installed).toBe(false);
    expect(report.hookStatus).toEqual({ installed: false, loaded: false });
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(effectiveCaptureEnabled(db).reason).toBe('hook_not_installed');
  });

  it('authorized consent writes the hooks and enables capture, but does not claim loaded', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    const report = await runInstall(db, {
      consent: true,
      settingsPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/tmp/bin/refluent',
      env: {},
    });
    expect(report.installed).toBe(true);
    expect(report.hookLoaded).toBe(false);
    expect(report.hookStatus).toEqual({ installed: true, loaded: false });
    expect(report.endpoint.status).toBe('not_configured');

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(saved)).toContain('user-prompt-submit');
    expect(JSON.stringify(saved)).toContain('session-start');
    expect(JSON.stringify(saved)).toContain('statusline');
    expect(verifyHookConfig(settingsPath)).toBe(true);
    expect(effectiveCaptureEnabled(db)).toEqual({ enabled: true, reason: 'hook_installed' });
    expect(hookStatus(db)).toBe('installed_not_loaded');
  });

  it('persists the non-secret endpoint and model so hooks do not depend on the shell profile', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    const env = {
      REFLUENT_MODEL_ENDPOINT: 'https://openrouter.ai/api/v1/',
      REFLUENT_MODEL: 'openai/gpt-4o-mini',
      REFLUENT_MODEL_API_KEY: 'sk-secret-that-must-not-be-stored',
      OPENROUTER_API_KEY: 'sk-another-value',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const report = await runInstall(db, {
      consent: true,
      settingsPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/tmp/bin/refluent',
      env,
    });
    vi.unstubAllGlobals();
    expect(report.endpoint.status).toBe('ready');

    // Endpoint and model survive; the secret does not.
    expect(getSetting(db, 'model-endpoint')).toBe('https://openrouter.ai/api/v1');
    expect(getSetting(db, 'model')).toBe('openai/gpt-4o-mini');
    expect(JSON.stringify(Object.fromEntries(
      (db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
    ))).not.toContain('sk-secret');

    // A later hook process with the empty environment still resolves the model.
    const reportWithEmptyEnv = buildSettingsReport(db);
    expect(reportWithEmptyEnv.model.endpoint).toBe('https://openrouter.ai/api/v1');
    expect(reportWithEmptyEnv.model.model).toBe('openai/gpt-4o-mini');
  });

  it('with no model configured, points at `refluent settings set`, not at shell variables', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    const report = await runInstall(db, {
      consent: true,
      settingsPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/tmp/bin/refluent',
      env: {},
    });
    const text = report.messages.join('\n');
    expect(text).toContain('refluent settings set model-endpoint <url>');
    expect(text).toContain('refluent settings set model-api-key-env <ENV_VAR>');
    expect(text).not.toContain('REFLUENT_MODEL_ENDPOINT');
    expect(report.apiKey).toEqual({ status: 'not_applicable', envName: null });
    expect(installSummary(report, agentDefinition('claude-code'))).toEqual([]);
  });

  it('reports a named key variable that is unset, and does not promise a suggestion', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    setSetting(db, 'model-endpoint', 'https://openrouter.ai/api/v1');
    setSetting(db, 'model', 'openai/gpt-4o-mini');
    setSetting(db, 'model-api-key-env', 'OPENROUTER_API_KEY');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const report = await runInstall(db, {
      consent: true,
      settingsPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/tmp/bin/refluent',
      env: {},
    });
    vi.unstubAllGlobals();
    expect(report.endpoint.status).toBe('ready');
    expect(report.apiKey).toEqual({ status: 'missing', envName: 'OPENROUTER_API_KEY' });

    const summary = installSummary(report, agentDefinition('claude-code')).join('\n');
    expect(summary).toContain('api key        : env OPENROUTER_API_KEY is not set in this shell');
    expect(summary).toContain('make sure OPENROUTER_API_KEY is set where Claude Code runs');
    expect(summary).not.toContain('to see the first suggestion');
  });

  it('promises the first suggestion once the key is visible', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    setSetting(db, 'model-endpoint', 'https://openrouter.ai/api/v1');
    setSetting(db, 'model', 'openai/gpt-4o-mini');
    setSetting(db, 'model-api-key-env', 'OPENROUTER_API_KEY');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const report = await runInstall(db, {
      consent: true,
      settingsPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/tmp/bin/refluent',
      env: { OPENROUTER_API_KEY: 'sk-test' },
    });
    vi.unstubAllGlobals();
    expect(report.apiKey).toEqual({ status: 'found', envName: 'OPENROUTER_API_KEY' });

    const summary = installSummary(report, agentDefinition('claude-code')).join('\n');
    expect(summary).toContain('api key        : read from env OPENROUTER_API_KEY');
    expect(summary).toContain('send your next message in Claude Code to see the first suggestion');
    expect(summary).not.toContain('sk-test');
  });

  it('with no key variable named, still allows a keyless endpoint but says how to add one', async () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    setSetting(db, 'model-endpoint', 'http://127.0.0.1:11434/v1');
    setSetting(db, 'model', 'some-local-model');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const report = await runInstall(db, {
      consent: true,
      settingsPath,
      nodePath: '/usr/local/bin/node',
      binPath: '/tmp/bin/refluent',
      env: {},
    });
    vi.unstubAllGlobals();
    expect(report.apiKey).toEqual({ status: 'not_named', envName: null });

    const summary = installSummary(report, agentDefinition('claude-code')).join('\n');
    expect(summary).toContain('api key        : none (fine for a local endpoint)');
    expect(summary).toContain('refluent settings set model-api-key-env <ENV_VAR>');
  });

  it('verifyHookConfig re-reads the file so a removed registration reports not loaded', () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    writeHookConfig(settingsPath, '/usr/local/bin/node', '/tmp/bin/refluent');
    expect(verifyHookConfig(settingsPath)).toBe(true);

    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), 'utf8');
    expect(verifyHookConfig(settingsPath)).toBe(false);
  });
});

describe('settings report: overlay', () => {
  it('reports not_installed when there is no LaunchAgent', () => {
    const report = buildSettingsReport(db, { overlayInstalled: false });
    expect(report.overlay).toBe('not_installed');
  });

  it('reports running from a fresh heartbeat', () => {
    setSetting(db, STATUS_KEY, 'running');
    setSetting(db, HEARTBEAT_KEY, new Date().toISOString());
    expect(buildSettingsReport(db, { overlayInstalled: true }).overlay).toBe('running');
  });

  it('lists overlay-duration among the switches', () => {
    expect(buildSettingsReport(db, { overlayInstalled: false }).preferences['overlay-duration']).toEqual({
      value: '12',
      default: '12',
      allowed: ['6', '12', '20', '30', '60'],
    });
  });
});