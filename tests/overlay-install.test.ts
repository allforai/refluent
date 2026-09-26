import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting, setPreference, setSetting } from '../src/settings.js';
import { LAST_SHOWN_ID_KEY } from '../src/overlay.js';
import {
  OVERLAY_LABEL,
  PREV_STATUSLINE_KEY,
  buildPlist,
  installOverlay,
  uninstallOverlay,
  type CommandRunner,
  type OverlayInstallOptions,
} from '../src/overlay-install.js';

let db: DatabaseType;
let tmp: string;
let calls: string[];
let failing: Set<string>;
/** How many more `launchctl print` calls report the old agent as still loaded. */
let stillLoaded: number;
/** How many more `launchctl bootstrap` calls fail with launchd's teardown race. */
let bootstrapRaces: number;
let slept: number[];

const fakeRun: CommandRunner = (command, args) => {
  const line = [command, ...args].join(' ');
  calls.push(line);
  for (const prefix of failing) if (line.startsWith(prefix)) return { status: 1, output: `${prefix} failed` };
  if (command === 'launchctl' && args[0] === 'print') {
    if (stillLoaded > 0) {
      stillLoaded -= 1;
      return { status: 0, output: 'state = running' };
    }
    return { status: 113, output: 'Could not find service' };
  }
  if (command === 'launchctl' && args[0] === 'bootstrap' && bootstrapRaces > 0) {
    bootstrapRaces -= 1;
    return { status: 5, output: 'Bootstrap failed: 5: Input/output error' };
  }
  if (command === 'xcrun' && args[0] === 'swiftc') fs.writeFileSync(args[args.indexOf('-o') + 1]!, 'binary');
  return { status: 0, output: '' };
};

function options(): OverlayInstallOptions {
  return {
    paths: {
      source: '/repo/overlay/RefluentOverlay.swift',
      binary: path.join(tmp, 'data', 'bin', 'refluent-overlay'),
      plist: path.join(tmp, 'LaunchAgents', `${OVERLAY_LABEL}.plist`),
      log: path.join(tmp, 'data', 'overlay.log'),
    },
    run: fakeRun,
    nodePath: '/usr/local/bin/node',
    binPath: '/repo/bin/refluent',
    uid: 501,
    dataDirOverride: null,
    platform: 'darwin',
    sleep: (ms) => slept.push(ms),
    claudeSettingsPath: path.join(tmp, 'claude', 'settings.json'),
  };
}

beforeEach(() => {
  db = memoryDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refluent-overlay-install-'));
  calls = [];
  failing = new Set();
  stillLoaded = 0;
  bootstrapRaces = 0;
  slept = [];
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('overlay install', () => {
  it('compiles, writes the LaunchAgent, starts it and turns the terminal line off', () => {
    const result = installOverlay(db, options());
    expect(result.ok).toBe(true);
    expect(calls).toContain(`xcrun swiftc -O -swift-version 5 /repo/overlay/RefluentOverlay.swift -o ${options().paths.binary}`);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${options().paths.plist}`);
    expect(fs.existsSync(options().paths.plist)).toBe(true);
    expect(getSetting(db, 'statusline-suggestion')).toBe('off');
    expect(getSetting(db, PREV_STATUSLINE_KEY)).toBe('on');
  });

  it('stops before changing anything when swiftc is missing', () => {
    failing.add('xcrun --find swiftc');
    const result = installOverlay(db, options());
    expect(result.ok).toBe(false);
    expect(result.messages.join('\n')).toContain('xcode-select --install');
    expect(fs.existsSync(options().paths.plist)).toBe(false);
    expect(getSetting(db, 'statusline-suggestion')).toBe('on');
    expect(calls.some((c) => c.startsWith('launchctl'))).toBe(false);
  });

  it('stops before writing the LaunchAgent when compilation fails', () => {
    failing.add('xcrun swiftc');
    const result = installOverlay(db, options());
    expect(result.ok).toBe(false);
    expect(fs.existsSync(options().paths.plist)).toBe(false);
    expect(getSetting(db, 'statusline-suggestion')).toBe('on');
  });

  it('leaves the terminal line alone when launchctl cannot start it', () => {
    failing.add('launchctl bootstrap');
    const result = installOverlay(db, options());
    expect(result.ok).toBe(false);
    expect(getSetting(db, 'statusline-suggestion')).toBe('on');
  });

  it('waits for the old agent to be torn down before starting the new one', () => {
    stillLoaded = 3;
    const result = installOverlay(db, options());
    expect(result.ok).toBe(true);
    const bootstrapAt = calls.findIndex((c) => c.startsWith('launchctl bootstrap'));
    const prints = calls.slice(0, bootstrapAt).filter((c) => c === `launchctl print gui/501/${OVERLAY_LABEL}`);
    expect(prints).toHaveLength(4);
    expect(slept.length).toBeGreaterThanOrEqual(3);
  });

  it('retries a bootstrap that lost the teardown race', () => {
    bootstrapRaces = 1;
    const result = installOverlay(db, options());
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(2);
    expect(getSetting(db, 'statusline-suggestion')).toBe('off');
  });

  it('gives up after the retry and leaves the terminal line alone', () => {
    bootstrapRaces = 5;
    const result = installOverlay(db, options());
    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(2);
    expect(getSetting(db, 'statusline-suggestion')).toBe('on');
  });

  it('refuses outside macOS', () => {
    const result = installOverlay(db, { ...options(), platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps the original status-line value when installed twice', () => {
    setPreference(db, 'statusline-suggestion', 'on');
    installOverlay(db, options());
    installOverlay(db, options());
    expect(getSetting(db, PREV_STATUSLINE_KEY)).toBe('on');
    uninstallOverlay(db, options());
    expect(getSetting(db, 'statusline-suggestion')).toBe('on');
  });

  it('restores an original value of off', () => {
    setPreference(db, 'statusline-suggestion', 'off');
    installOverlay(db, options());
    uninstallOverlay(db, options());
    expect(getSetting(db, 'statusline-suggestion')).toBe('off');
  });
});

describe('overlay: Claude Code status row', () => {
  function claudeSettings(content: Record<string, unknown>): string {
    const file = options().claudeSettingsPath!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content), 'utf8');
    return file;
  }
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  const refluentHooks = {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/bin/refluent hook user-prompt-submit' }] }],
  };

  it('install removes the empty refluent status row, uninstall brings it back', () => {
    const file = claudeSettings({
      hooks: refluentHooks,
      statusLine: { type: 'command', command: 'node /x/bin/refluent hook statusline' },
    });
    expect(installOverlay(db, options()).ok).toBe(true);
    expect(read(file).statusLine).toBeUndefined();
    expect(uninstallOverlay(db, options()).ok).toBe(true);
    expect(read(file).statusLine.command).toBe('/usr/local/bin/node /repo/bin/refluent hook statusline --agent claude-code');
  });

  it('does not touch Claude Code settings when the install fails', () => {
    const file = claudeSettings({
      hooks: refluentHooks,
      statusLine: { type: 'command', command: 'node /x/bin/refluent hook statusline' },
    });
    failing.add('launchctl bootstrap');
    bootstrapRaces = 0;
    expect(installOverlay(db, options()).ok).toBe(false);
    expect(read(file).statusLine.command).toContain('refluent');
  });

  it('works without any Claude Code settings file', () => {
    expect(installOverlay(db, options()).ok).toBe(true);
    expect(uninstallOverlay(db, options()).ok).toBe(true);
    expect(fs.existsSync(options().claudeSettingsPath!)).toBe(false);
  });
});

describe('overlay uninstall', () => {
  it('stops the agent, removes its files and resets the cursor', () => {
    installOverlay(db, options());
    setSetting(db, LAST_SHOWN_ID_KEY, '7');
    const result = uninstallOverlay(db, options());
    expect(result.ok).toBe(true);
    expect(calls).toContain(`launchctl bootout gui/501/${OVERLAY_LABEL}`);
    expect(fs.existsSync(options().paths.plist)).toBe(false);
    expect(fs.existsSync(options().paths.binary)).toBe(false);
    expect(getSetting(db, LAST_SHOWN_ID_KEY)).toBe('');
    expect(getSetting(db, PREV_STATUSLINE_KEY)).toBe('');
  });

  it('is harmless when nothing was installed', () => {
    failing.add('launchctl bootout');
    expect(uninstallOverlay(db, options()).ok).toBe(true);
    expect(getSetting(db, 'statusline-suggestion')).toBe('on');
  });
});

describe('overlay plist', () => {
  it('runs the absolute node and bin paths and restarts only after a crash', () => {
    const plist = buildPlist({ nodePath: '/n/node', binPath: '/r/bin/refluent', logPath: '/d/overlay.log', dataDirOverride: null });
    expect(plist).toContain(`<string>${OVERLAY_LABEL}</string>`);
    expect(plist).toMatch(/<string>\/n\/node<\/string>\s*<string>\/r\/bin\/refluent<\/string>\s*<string>overlay<\/string>\s*<string>run<\/string>/);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).not.toContain('REFLUENT_DATA_DIR');
  });

  it('passes a data-directory override through and escapes XML', () => {
    const plist = buildPlist({ nodePath: '/n/node', binPath: '/r/a&b/refluent', logPath: '/d/log', dataDirOverride: '/tmp/<data>' });
    expect(plist).toContain('<key>REFLUENT_DATA_DIR</key>');
    expect(plist).toContain('/tmp/&lt;data&gt;');
    expect(plist).toContain('/r/a&amp;b/refluent');
  });
});
