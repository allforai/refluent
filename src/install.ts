import fs from 'node:fs';
import path from 'node:path';
import { dataDir, nowIso, stableNodePath } from './config.js';
import type { DatabaseType } from './db.js';
import { HttpAnalysisClient, analysisClientFor, type EndpointProbe } from './analysis/http.js';
import { getSetting, setSetting } from './settings.js';
import { DEFAULT_AGENT, agentDefinition, type AgentId } from './agents.js';
import { PI_EXTENSION_FILENAME, piExtensionSource } from './pi-extension.js';
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
  /** Claude settings file, Codex hooks file, or the Pi extensions directory. */
  settingsPath: string;
  nodePath?: string;
  binPath: string;
  env?: NodeJS.ProcessEnv;
  agent?: AgentId;
  /** The overlay shows suggestions, so Claude Code's statusLine is left to the user. */
  overlayInstalled?: boolean;
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
  agent: AgentId = DEFAULT_AGENT,
): { capture: string; sessionStart: string; statusline: string } {
  const suffix = ` --agent ${agent}`;
  return {
    capture: `${nodePath} ${binPath} hook user-prompt-submit${suffix}`,
    sessionStart: `${nodePath} ${binPath} hook session-start${suffix}`,
    statusline: `${nodePath} ${binPath} hook statusline${suffix}`,
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
 * Merges the refluent hook registration into an agent's hook file. The shape is
 * the same for Claude Code (`~/.claude/settings.json`) and Codex
 * (`~/.codex/hooks.json`): `{hooks: {Event: [{hooks: [{type, command}]}]}}`, with
 * the same event names. Only Claude Code gets a statusLine, because only Claude
 * Code has a command-driven status line to own; Codex's is a built-in toggle.
 * The original file is copied once to `<settings>.refluent-backup`.
 */
export function writeAgentHookConfig(
  settingsPath: string,
  nodePath: string,
  binPath: string,
  agent: AgentId = DEFAULT_AGENT,
  ownStatusLine = true,
): HookConfigWrite {
  const settings = readSettingsFile(settingsPath);
  const commands = hookCommands(nodePath, binPath, agent);
  const backupPath = `${settingsPath}.refluent-backup`;
  if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(settingsPath, backupPath);
  }
  let previousStatusLine: Record<string, unknown> | null = null;
  const claimsStatusLine = agentDefinition(agent).hasInjectableStatusline && ownStatusLine;
  if (claimsStatusLine) {
    const existing = settings.statusLine;
    previousStatusLine =
      existing && typeof existing === 'object' && !isRefluentEntry(existing)
        ? (existing as Record<string, unknown>)
        : null;
  }

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
  if (claimsStatusLine) {
    settings.statusLine = { type: 'command', command: commands.statusline };
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { previousStatusLine };
}

/** Claude Code keeps its own name for the same write, for existing callers and tests. */
export function writeHookConfig(settingsPath: string, nodePath: string, binPath: string): HookConfigWrite {
  return writeAgentHookConfig(settingsPath, nodePath, binPath, 'claude-code');
}

/** Removes every refluent entry and puts back the user's own statusLine, if one was wrapped. */
export function removeAgentHookConfig(
  settingsPath: string,
  restoreStatusLine: Record<string, unknown> | null,
  agent: AgentId = DEFAULT_AGENT,
): void {
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
  if (agentDefinition(agent).hasInjectableStatusline && isRefluentEntry(settings.statusLine)) {
    if (restoreStatusLine) settings.statusLine = restoreStatusLine;
    else delete settings.statusLine;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** Claude Code keeps its own name for the same removal, for existing callers and tests. */
export function removeHookConfig(settingsPath: string, restoreStatusLine: Record<string, unknown> | null): void {
  removeAgentHookConfig(settingsPath, restoreStatusLine, 'claude-code');
}

export const WRAPPED_STATUSLINE_KEY = 'wrapped_statusline';

function storedWrappedStatusLine(db: DatabaseType): Record<string, unknown> | null {
  const raw = getSetting(db, WRAPPED_STATUSLINE_KEY) ?? '';
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Hands Claude Code's statusLine back while the overlay shows suggestions: the user's own
 * wrapped statusLine, or none at all. A refluent statusLine with nothing to print still
 * costs the pane an empty row. Returns whether the file changed.
 */
export function releaseStatusLine(db: DatabaseType, settingsPath: string): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  const settings = readSettingsFile(settingsPath);
  if (!isRefluentEntry(settings.statusLine)) return false;
  const restore = storedWrappedStatusLine(db);
  if (restore) settings.statusLine = restore;
  else delete settings.statusLine;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Takes Claude Code's statusLine back for refluent when the overlay goes away, wrapping
 * whatever statusLine the user has by then. Only where refluent's hooks are installed.
 */
export function claimStatusLine(db: DatabaseType, settingsPath: string, nodePath: string, binPath: string): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  const settings = readSettingsFile(settingsPath);
  if (!isRefluentEntry((settings.hooks as Record<string, unknown> | undefined)?.UserPromptSubmit)) return false;
  if (isRefluentEntry(settings.statusLine)) return false;
  const existing = settings.statusLine;
  setSetting(db, WRAPPED_STATUSLINE_KEY, existing && typeof existing === 'object' ? JSON.stringify(existing) : '');
  settings.statusLine = { type: 'command', command: hookCommands(nodePath, binPath, 'claude-code').statusline };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

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

export function runUninstall(db: DatabaseType, settingsPath: string, agent: AgentId = DEFAULT_AGENT): string[] {
  const raw = getSetting(db, WRAPPED_STATUSLINE_KEY) ?? '';
  let restore: Record<string, unknown> | null = null;
  try {
    restore = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    restore = null;
  }
  if (agentDefinition(agent).capture === 'extension') {
    const removed = removePiExtension(settingsPath);
    setSetting(db, 'hook_installed', 'false');
    setSetting(db, 'hook_seen_at', '');
    return [
      removed ? `Removed the refluent Pi extension from: ${settingsPath}` : `No refluent Pi extension at: ${settingsPath}`,
      'Restart Pi so the extension is unloaded.',
      'Your knowledge points are kept; delete the data directory to remove them.',
    ];
  }
  removeAgentHookConfig(settingsPath, restore, agent);
  setSetting(db, 'hook_installed', 'false');
  setSetting(db, 'hook_seen_at', '');
  setSetting(db, WRAPPED_STATUSLINE_KEY, '');
  return [
    `Removed the refluent hooks from: ${settingsPath}`,
    agentDefinition(agent).hasInjectableStatusline
      ? restore
        ? 'Restored your previous statusLine.'
        : 'Removed the refluent statusLine.'
      : 'Left the status line alone: this agent has no injectable status line.',
    'Your knowledge points are kept; delete the data directory to remove them.',
  ];
}

export function verifyAgentHookConfig(
  settingsPath: string,
  agent: AgentId = DEFAULT_AGENT,
  ownStatusLine = true,
): boolean {
  try {
    const settings = readSettingsFile(settingsPath);
    const json = JSON.stringify(settings);
    const needsStatusline = agentDefinition(agent).hasInjectableStatusline && ownStatusLine;
    return (
      json.includes('refluent') &&
      json.includes('UserPromptSubmit') &&
      json.includes('SessionStart') &&
      (!needsStatusline || json.includes('statusline'))
    );
  } catch {
    return false;
  }
}

/** Claude Code keeps its own name for the same check, for existing callers and tests. */
export function verifyHookConfig(settingsPath: string): boolean {
  return verifyAgentHookConfig(settingsPath, 'claude-code');
}

/** The Pi extension refluent owns; Pi loads it from its personal extensions directory. */
export function writePiExtension(extensionsDir: string, nodePath: string, binPath: string): string {
  fs.mkdirSync(extensionsDir, { recursive: true });
  const target = path.join(extensionsDir, PI_EXTENSION_FILENAME);
  fs.writeFileSync(target, piExtensionSource({ nodePath, binPath }), 'utf8');
  return target;
}

export function verifyPiExtension(extensionsDir: string): boolean {
  try {
    const target = path.join(extensionsDir, PI_EXTENSION_FILENAME);
    return fs.readFileSync(target, 'utf8').includes('install --agent pi');
  } catch {
    return false;
  }
}

export function removePiExtension(extensionsDir: string): boolean {
  const target = path.join(extensionsDir, PI_EXTENSION_FILENAME);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
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
  const client = analysisClientFor(db, env);
  if (!(client instanceof HttpAnalysisClient)) {
    return { status: 'not_configured', error: null, checkedAt: nowIso() };
  }
  return client.probe();
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
 * A key that only this shell can see is not visible to the hook. Naming a
 * variable does not move a value between environments: `model-api-key-env`
 * only chooses *which* variable the hook looks up, so the guidance is to name
 * one the agent already passes to its hooks.
 */
function describeKeyVisibility(db: DatabaseType, env: NodeJS.ProcessEnv, messages: string[]): void {
  const resolved = resolveModelConfig(db, env);
  if (!resolved.env) return;
  if (!resolved.env.apiKey) {
    if (resolved.apiKeyEnvNameConfigured) {
      messages.push(
        `model-api-key-env names ${resolved.apiKeyEnvNameConfigured}, which is not set in this shell. Hooks read it from the agent's environment, so confirm it there (this shell proves nothing either way).`,
      );
    } else {
      messages.push(
        'No analysis API key is reachable from this shell: name a variable that Claude Code passes to its hooks, e.g. `refluent settings set model-api-key-env OPENROUTER_API_KEY`.',
      );
    }
    return;
  }
  if (resolved.apiKeyEnvName === 'REFLUENT_MODEL_API_KEY') {
    messages.push(
      'The API key came from REFLUENT_MODEL_API_KEY in this shell only. Hooks inherit the agent\'s environment, not this shell: name a variable the agent already has, e.g. `refluent settings set model-api-key-env OPENROUTER_API_KEY`.',
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

  const agent = options.agent ?? DEFAULT_AGENT;
  const definition = agentDefinition(agent);
  const nodePath = options.nodePath ?? stableNodePath();

  let registered: boolean;
  if (definition.capture === 'extension') {
    const written = writePiExtension(options.settingsPath, nodePath, options.binPath);
    registered = verifyPiExtension(options.settingsPath);
    messages.push(`Wrote the Pi extension to: ${written}`);
    messages.push('Restart Pi so it loads the extension; it captures your outgoing prompts and shows the suggestion in Pi\'s status bar.');
  } else {
    const ownStatusLine = !options.overlayInstalled;
    // A stale refluent statusLine from before the overlay is handed back first, so the
    // rewrite below does not have to know about it.
    if (!ownStatusLine && definition.hasInjectableStatusline) releaseStatusLine(db, options.settingsPath);
    const { previousStatusLine } = writeAgentHookConfig(options.settingsPath, nodePath, options.binPath, agent, ownStatusLine);
    if (previousStatusLine) {
      setSetting(db, WRAPPED_STATUSLINE_KEY, JSON.stringify(previousStatusLine));
      messages.push('Your existing statusLine is kept: refluent runs it and adds its own line below.');
    }
    registered = verifyAgentHookConfig(options.settingsPath, agent, ownStatusLine);
    messages.push(
      definition.hasInjectableStatusline && ownStatusLine
        ? `Wrote the UserPromptSubmit and SessionStart hooks and the statusLine to: ${options.settingsPath}`
        : `Wrote the UserPromptSubmit and SessionStart hooks to: ${options.settingsPath}`,
    );
    if (definition.hasInjectableStatusline && !ownStatusLine) {
      messages.push('Suggestions pop up in the overlay, so the statusLine is left to you.');
    }
    if (!definition.hasInjectableStatusline) {
      messages.push(
        `${definition.label} has no status line refluent can render into, so suggestions are captured now and read later with \`refluent review\`.`,
      );
    }
    if (agent === 'codex') {
      messages.push(
        'Codex runs only hooks it has trusted: the first time it sees this one it asks you to approve it, and `codex exec` needs that approval too (or --dangerously-bypass-hook-trust in automation).',
      );
    }
  }
  setSetting(db, 'hook_installed', registered ? 'true' : 'false');
  const loaded = (getSetting(db, 'hook_seen_at') ?? '') !== '';
  if (!loaded) {
    messages.push(`${definition.label} has not run the hook yet: send any message there, then run \`refluent settings\` to confirm.`);
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