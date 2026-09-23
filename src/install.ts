import fs from 'node:fs';
import path from 'node:path';
import { dataDir, nowIso } from './config.js';
import type { DatabaseType } from './db.js';
import { HttpAnalysisClient, type EndpointProbe } from './analysis/http.js';
import { getSetting, setSetting } from './settings.js';
import {
  MODEL_ENDPOINT_KEY,
  MODEL_KEY,
  normalizeEndpoint,
  resolveModelConfig,
  sanitizedEndpoint,
  setModelSetting,
} from './model-config.js';

export interface HookStatus {
  installed: boolean;
  loaded: boolean;
}

export interface InstallOptions {
  consent: boolean;
  settingsPath: string;
  nodePath?: string;
  binPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallReport {
  installed: boolean;
  captureEnabled: boolean;
  hookPath: string;
  hookLoaded: boolean;
  hookStatus: HookStatus;
  endpoint: EndpointProbe;
  dataDir: string;
  dataDirWritable: boolean;
  messages: string[];
}

export function hookCommands(
  nodePath: string,
  binPath: string,
): { capture: string; sessionStart: string; statusline: string } {
  return {
    capture: `${nodePath} ${binPath} hook user-prompt-submit`,
    sessionStart: `${nodePath} ${binPath} hook session-start`,
    statusline: `${nodePath} ${binPath} hook statusline`,
  };
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // A missing or unreadable file is created fresh; a malformed file is not
    // silently overwritten with unrelated content, so we return an empty object
    // only after a parse failure of an existing file.
    if (fs.existsSync(settingsPath)) {
      throw new Error(`refusing to overwrite unparseable settings file: ${settingsPath}`);
    }
  }
  return {};
}

function withoutRefluent(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => !JSON.stringify(entry).includes('refluent'));
}

function isRefluentEntry(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('refluent');
}

export interface HookConfigWrite {
  /** The user's own statusLine that refluent now wraps, or null if there was none. */
  previousStatusLine: Record<string, unknown> | null;
}

/**
 * Merges the refluent hook registration into a Claude Code settings file.
 * Claude Code runs a single statusLine, so an existing non-refluent statusLine
 * is returned for the caller to keep and run from inside the refluent one. The
 * original file is copied once to `<settings>.refluent-backup`.
 */
export function writeHookConfig(settingsPath: string, nodePath: string, binPath: string): HookConfigWrite {
  const settings = readSettingsFile(settingsPath);
  const commands = hookCommands(nodePath, binPath);
  const backupPath = `${settingsPath}.refluent-backup`;
  if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(settingsPath, backupPath);
  }
  const existing = settings.statusLine;
  const previousStatusLine =
    existing && typeof existing === 'object' && !isRefluentEntry(existing)
      ? (existing as Record<string, unknown>)
      : null;

  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<
    string,
    unknown
  >;
  hooks.UserPromptSubmit = [
    ...withoutRefluent(hooks.UserPromptSubmit),
    { hooks: [{ type: 'command', command: commands.capture }] },
  ];
  hooks.SessionStart = [
    ...withoutRefluent(hooks.SessionStart),
    { hooks: [{ type: 'command', command: commands.sessionStart }] },
  ];
  settings.hooks = hooks;
  settings.statusLine = { type: 'command', command: commands.statusline };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { previousStatusLine };
}

/** Removes every refluent entry and puts back the user's own statusLine, if one was wrapped. */
export function removeHookConfig(settingsPath: string, restoreStatusLine: Record<string, unknown> | null): void {
  if (!fs.existsSync(settingsPath)) return;
  const settings = readSettingsFile(settingsPath);
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, unknown>;
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const kept = withoutRefluent(hooks[event]);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  // A user whose settings had no `hooks` key must get their file back unchanged;
  // writing an empty object would leave a trace of the install behind. Hooks the
  // user already had are preserved above and keep the key alive.
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  if (isRefluentEntry(settings.statusLine)) {
    if (restoreStatusLine) settings.statusLine = restoreStatusLine;
    else delete settings.statusLine;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export const WRAPPED_STATUSLINE_KEY = 'wrapped_statusline';

/** The wrapped statusLine command, if any; the refluent statusLine runs it first. */
export function wrappedStatusLineCommand(db: DatabaseType): string | null {
  const raw = getSetting(db, WRAPPED_STATUSLINE_KEY) ?? '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { command?: unknown };
    return typeof parsed.command === 'string' && parsed.command.length > 0 ? parsed.command : null;
  } catch {
    return null;
  }
}

export function runUninstall(db: DatabaseType, settingsPath: string): string[] {
  const raw = getSetting(db, WRAPPED_STATUSLINE_KEY) ?? '';
  let restore: Record<string, unknown> | null = null;
  try {
    restore = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    restore = null;
  }
  removeHookConfig(settingsPath, restore);
  setSetting(db, 'hook_installed', 'false');
  setSetting(db, 'hook_seen_at', '');
  setSetting(db, WRAPPED_STATUSLINE_KEY, '');
  return [
    `Removed the refluent hooks from: ${settingsPath}`,
    restore ? 'Restored your previous statusLine.' : 'Removed the refluent statusLine.',
    'Your knowledge points are kept; delete the data directory to remove them.',
  ];
}

/**
 * Whether the settings file still contains our hook registration. This proves
 * the hook is *registered*, not that Claude Code runs it: that is recorded by
 * the hook itself (see `markHookSeen`).
 */
export function verifyHookConfig(settingsPath: string): boolean {
  try {
    const settings = readSettingsFile(settingsPath);
    const json = JSON.stringify(settings);
    return (
      json.includes('refluent') &&
      json.includes('UserPromptSubmit') &&
      json.includes('SessionStart') &&
      json.includes('statusline')
    );
  } catch {
    return false;
  }
}

function dataDirWritable(): boolean {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const probe = path.join(dataDir(), '.write-probe');
    fs.writeFileSync(probe, 'refluent writability probe', 'utf8');
    const readBack = fs.readFileSync(probe, 'utf8');
    fs.unlinkSync(probe);
    return readBack === 'refluent writability probe';
  } catch {
    return false;
  }
}

export async function probeEndpoint(db: DatabaseType, env: NodeJS.ProcessEnv = process.env): Promise<EndpointProbe> {
  const resolved = resolveModelConfig(db, env);
  if (!resolved.env) {
    return { status: 'not_configured', error: null, checkedAt: nowIso() };
  }
  return new HttpAnalysisClient(resolved.env).probe();
}

/**
 * The endpoint and model are not secrets, so install copies them out of the
 * environment into local settings: Claude Code's hooks are children of the
 * agent and never see a variable that only a terminal profile defines. The API
 * key is deliberately not stored.
 */
function persistEnvModelConfig(db: DatabaseType, env: NodeJS.ProcessEnv, messages: string[]): void {
  const envEndpoint = normalizeEndpoint(env.REFLUENT_MODEL_ENDPOINT);
  const envModel = env.REFLUENT_MODEL?.trim();
  let saved = false;
  if (envEndpoint && setModelSetting(db, MODEL_ENDPOINT_KEY, envEndpoint).ok) saved = true;
  if (envModel && setModelSetting(db, MODEL_KEY, envModel).ok) saved = true;
  if (saved) {
    const effective = normalizeEndpoint(getSetting(db, MODEL_ENDPOINT_KEY));
    messages.push(
      `Saved the analysis endpoint and model locally (${sanitizedEndpoint(effective)}), so hooks do not depend on your shell profile.`,
    );
  }
}

/**
 * A key that only this shell can see is invisible to the hook. Point at the
 * variable by name instead of copying the secret into refluent's own state.
 */
function describeKeyVisibility(db: DatabaseType, env: NodeJS.ProcessEnv, messages: string[]): void {
  const resolved = resolveModelConfig(db, env);
  if (!resolved.env) return;
  if (!resolved.env.apiKey) {
    if (resolved.apiKeyEnvNameConfigured) {
      messages.push(
        `The variable named by model-api-key-env (${resolved.apiKeyEnvNameConfigured}) is empty or unset in this shell; the hook reads it from the agent's own environment.`,
      );
    } else {
      messages.push(
        'No analysis API key is visible in this shell: set `refluent settings set model-api-key-env <ENV_VAR_NAME>` (for example OPENROUTER_API_KEY) so the hook can read the key by name.',
      );
    }
    return;
  }
  if (resolved.apiKeyEnvName === 'REFLUENT_MODEL_API_KEY') {
    messages.push(
      'The API key came from REFLUENT_MODEL_API_KEY, which Claude Code hooks may not inherit: prefer `refluent settings set model-api-key-env <ENV_VAR_NAME>`.',
    );
  }
}

export function recordEndpointProbe(db: DatabaseType, probe: EndpointProbe): void {
  setSetting(db, 'endpoint_status', probe.status);
  setSetting(db, 'endpoint_checked_at', probe.checkedAt);
  setSetting(db, 'endpoint_error', probe.error ?? '');
}

/**
 * First-run setup. A declined consent neither writes hooks nor leaves a
 * half-enabled capture state. A one-time real probe decides endpoint readiness.
 */
export async function runInstall(db: DatabaseType, options: InstallOptions): Promise<InstallReport> {
  const messages: string[] = [];
  const writable = dataDirWritable();
  const endpointEnv = options.env ?? process.env;

  if (!writable) {
    setSetting(db, 'hook_installed', 'false');
    messages.push(`The local data directory is not writable: ${dataDir()}`);
    messages.push('Installation stopped without writing any hook.');
    return {
      installed: false,
      captureEnabled: false,
      hookPath: options.settingsPath,
      hookLoaded: false,
      hookStatus: { installed: false, loaded: false },
      endpoint: { status: 'not_configured', error: null, checkedAt: nowIso() },
      dataDir: dataDir(),
      dataDirWritable: false,
      messages,
    };
  }
  messages.push(`Local data directory is writable: ${dataDir()}`);

  if (!options.consent) {
    setSetting(db, 'hook_installed', 'false');
    messages.push('Hook installation was declined. Capture is not enabled and nothing is recorded.');
    messages.push('Re-run `refluent install` any time to authorize.');
    return {
      installed: false,
      captureEnabled: false,
      hookPath: options.settingsPath,
      hookLoaded: false,
      hookStatus: { installed: false, loaded: false },
      endpoint: { status: 'not_configured', error: null, checkedAt: nowIso() },
      dataDir: dataDir(),
      dataDirWritable: true,
      messages,
    };
  }

  const nodePath = options.nodePath ?? process.execPath;
  const { previousStatusLine } = writeHookConfig(options.settingsPath, nodePath, options.binPath);
  if (previousStatusLine) {
    setSetting(db, WRAPPED_STATUSLINE_KEY, JSON.stringify(previousStatusLine));
    messages.push('Your existing statusLine is kept: refluent runs it and adds its own line below.');
  }
  const registered = verifyHookConfig(options.settingsPath);
  setSetting(db, 'hook_installed', registered ? 'true' : 'false');
  const loaded = (getSetting(db, 'hook_seen_at') ?? '') !== '';
  messages.push(`Wrote the UserPromptSubmit and SessionStart hooks and the statusLine to: ${options.settingsPath}`);
  if (!loaded) {
    messages.push('Claude Code has not run the hook yet: send any message there, then run `refluent settings` to confirm.');
  }
  messages.push('Only your outgoing messages are captured; agent replies, code and logs are never captured.');

  persistEnvModelConfig(db, endpointEnv, messages);

  const endpoint = await probeEndpoint(db, endpointEnv);
  recordEndpointProbe(db, endpoint);
  if (endpoint.status === 'ready') {
    messages.push('Analysis endpoint probe succeeded: ready.');
  } else if (endpoint.status === 'not_configured') {
    messages.push('Analysis endpoint is not configured (set REFLUENT_MODEL_ENDPOINT / REFLUENT_MODEL_API_KEY / REFLUENT_MODEL).');
    messages.push('Capture stays enabled but no suggestions will be produced until it is configured.');
  } else {
    messages.push(`Analysis endpoint is unreachable: ${endpoint.error ?? 'unknown error'}`);
    messages.push('Capture stays enabled but no suggestions will be produced until it works.');
  }
  describeKeyVisibility(db, endpointEnv, messages);
  return {
    installed: registered,
    captureEnabled: registered,
    hookPath: options.settingsPath,
    hookLoaded: loaded,
    hookStatus: { installed: registered, loaded },
    endpoint,
    dataDir: dataDir(),
    dataDirWritable: true,
    messages,
  };
}