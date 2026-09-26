import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseType } from './db.js';
import { dataDir } from './config.js';
import { getSetting, setSetting } from './settings.js';
import { LAST_SHOWN_ID_KEY, STATUS_KEY } from './overlay.js';
import { claimStatusLine, releaseStatusLine } from './install.js';

export const OVERLAY_LABEL = 'com.refluent.overlay';
/** The `statusline-suggestion` value from before the overlay turned it off. */
export const PREV_STATUSLINE_KEY = 'overlay-prev-statusline-suggestion';

export interface OverlayPaths {
  source: string;
  binary: string;
  plist: string;
  log: string;
}

export function defaultOverlayPaths(): OverlayPaths {
  return {
    source: fileURLToPath(new URL('../overlay/RefluentOverlay.swift', import.meta.url)),
    binary: path.join(dataDir(), 'bin', 'refluent-overlay'),
    plist: path.join(os.homedir(), 'Library', 'LaunchAgents', `${OVERLAY_LABEL}.plist`),
    log: path.join(dataDir(), 'overlay.log'),
  };
}

export type CommandRunner = (command: string, args: string[]) => { status: number; output: string };

export const runCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`,
  };
};

export interface OverlayInstallOptions {
  paths: OverlayPaths;
  run: CommandRunner;
  nodePath: string;
  binPath: string;
  uid: number;
  dataDirOverride: string | null;
  platform?: NodeJS.Platform;
  /** Blocking pause between launchctl polls; a test passes a recorder. */
  sleep?: (ms: number) => void;
  /** Claude Code settings whose refluent statusLine the overlay replaces, if any. */
  claudeSettingsPath?: string | null;
}

export interface OverlayInstallResult {
  ok: boolean;
  messages: string[];
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The LaunchAgent starts the runner at login and restarts it only after a crash: a clean
 * exit (SIGTERM, or the supervisor giving up on a broken helper) is left stopped.
 */
export function buildPlist(options: {
  nodePath: string;
  binPath: string;
  logPath: string;
  dataDirOverride: string | null;
}): string {
  const env = options.dataDirOverride
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>REFLUENT_DATA_DIR</key>
    <string>${xml(options.dataDirOverride)}</string>
  </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${OVERLAY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.nodePath)}</string>
    <string>${xml(options.binPath)}</string>
    <string>overlay</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>${xml(options.logPath)}</string>${env}
</dict>
</plist>
`;
}

/** launchd tears a booted-out job down asynchronously; allow it up to 5 s. */
const TEARDOWN_POLL_MS = 250;
const TEARDOWN_POLLS = 20;
const BOOTSTRAP_RETRY_MS = 1000;

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stops any running agent and starts the one in the plist. A bootstrap issued while the
 * old job is still being torn down fails with "Bootstrap failed: 5: Input/output error",
 * so wait until launchd no longer knows the label, and retry the bootstrap once.
 */
function restartAgent(options: OverlayInstallOptions): { status: number; output: string } {
  const { run } = options;
  const sleep = options.sleep ?? blockingSleep;
  const target = `gui/${options.uid}/${OVERLAY_LABEL}`;
  // A first install has nothing to stop.
  run('launchctl', ['bootout', target]);
  for (let poll = 0; poll < TEARDOWN_POLLS && run('launchctl', ['print', target]).status === 0; poll += 1) {
    sleep(TEARDOWN_POLL_MS);
  }
  const bootstrap = () => run('launchctl', ['bootstrap', `gui/${options.uid}`, options.paths.plist]);
  const first = bootstrap();
  if (first.status === 0) return first;
  sleep(BOOTSTRAP_RETRY_MS);
  return bootstrap();
}

export function installOverlay(db: DatabaseType, options: OverlayInstallOptions): OverlayInstallResult {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { ok: false, messages: ['The overlay is macOS only. Nothing was changed.'] };
  }
  const { paths, run } = options;
  if (run('xcrun', ['--find', 'swiftc']).status !== 0) {
    return {
      ok: false,
      messages: ['swiftc was not found. Run `xcode-select --install`, then retry. Nothing was changed.'],
    };
  }
  fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
  const compile = run('xcrun', ['swiftc', '-O', '-swift-version', '5', paths.source, '-o', paths.binary]);
  if (compile.status !== 0) {
    return {
      ok: false,
      messages: ['Could not compile the overlay helper. Nothing else was changed.', compile.output.trim()],
    };
  }
  fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
  fs.writeFileSync(
    paths.plist,
    buildPlist({
      nodePath: options.nodePath,
      binPath: options.binPath,
      logPath: paths.log,
      dataDirOverride: options.dataDirOverride,
    }),
    'utf8',
  );
  const boot = restartAgent(options);
  if (boot.status !== 0) {
    return {
      ok: false,
      messages: [
        `launchctl could not start the overlay: ${boot.output.trim()}`,
        'The terminal status line was left unchanged.',
      ],
    };
  }
  if (!getSetting(db, PREV_STATUSLINE_KEY)) {
    setSetting(db, PREV_STATUSLINE_KEY, getSetting(db, 'statusline-suggestion') ?? 'on');
  }
  setSetting(db, 'statusline-suggestion', 'off');
  const releasedRow = options.claudeSettingsPath ? releaseStatusLine(db, options.claudeSettingsPath) : false;
  return {
    ok: true,
    messages: [
      ...(releasedRow ? ['Removed the refluent status row from Claude Code.'] : []),
      `Overlay helper compiled: ${paths.binary}`,
      `LaunchAgent written and started: ${paths.plist}`,
      'The terminal status line is off; suggestions now pop up in the overlay.',
      'Run `refluent overlay test` to see it and drag it where you want it.',
    ],
  };
}

export function uninstallOverlay(db: DatabaseType, options: OverlayInstallOptions): OverlayInstallResult {
  const { paths, run } = options;
  // Not loaded is fine: uninstall is idempotent.
  run('launchctl', ['bootout', `gui/${options.uid}/${OVERLAY_LABEL}`]);
  fs.rmSync(paths.plist, { force: true });
  fs.rmSync(paths.binary, { force: true });
  const previous = getSetting(db, PREV_STATUSLINE_KEY);
  if (previous) setSetting(db, 'statusline-suggestion', previous);
  setSetting(db, PREV_STATUSLINE_KEY, '');
  const claimedRow = options.claudeSettingsPath
    ? claimStatusLine(db, options.claudeSettingsPath, options.nodePath, options.binPath)
    : false;
  setSetting(db, LAST_SHOWN_ID_KEY, '');
  setSetting(db, STATUS_KEY, '');
  return {
    ok: true,
    messages: [
      'Overlay stopped and removed.',
      previous ? `Terminal status line restored to: ${previous}` : 'Terminal status line unchanged.',
      ...(claimedRow ? ['Put the refluent status row back in Claude Code.'] : []),
    ],
  };
}
