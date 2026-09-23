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
  probeEndpoint,
  recordEndpointProbe,
  runInstall,
  verifyHookConfig,
  writeHookConfig,
} from '../src/install.js';
import { buildSettingsReport } from '../src/cli.js';

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

  it('endpoint liveness with no environment is not_configured and never probes the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const probe = await probeEndpoint({});
    expect(probe.status).toBe('not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('classifies a reachable endpoint as ready and an unreachable one as unreachable', async () => {
    const env = { REFLUENT_MODEL_ENDPOINT: 'http://localhost:9/v1', REFLUENT_MODEL: 'small-model' };

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect((await probeEndpoint(env)).status).toBe('ready');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }));
    const down = await probeEndpoint(env);
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

  it('verifyHookConfig re-reads the file so a removed registration reports not loaded', () => {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    writeHookConfig(settingsPath, '/usr/local/bin/node', '/tmp/bin/refluent');
    expect(verifyHookConfig(settingsPath)).toBe(true);

    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), 'utf8');
    expect(verifyHookConfig(settingsPath)).toBe(false);
  });
});