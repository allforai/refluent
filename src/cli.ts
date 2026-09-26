import fs from 'node:fs';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { claudeSettingsPath, codexHooksPath, dataDir, dbPath, piExtensionsDir, stableNodePath } from './config.js';
import { openDatabase, type DatabaseType } from './db.js';
import { overlayStatus, requestTestOverlay, type OverlayStatus } from './overlay.js';
import { runOverlay } from './overlay-runner.js';
import {
  defaultOverlayPaths,
  installOverlay,
  runCommand,
  uninstallOverlay,
  type OverlayInstallOptions,
} from './overlay-install.js';
import { analysisClientFor } from './analysis/http.js';
import type { AnalysisClient } from './analysis/types.js';
import { captureMessage, runAnalysis } from './capture.js';
import { runInstall, runUninstall, probeEndpoint, recordEndpointProbe } from './install.js';
import {
  ALLOWED_VALUES,
  PREFERENCE_DEFAULTS,
  PREFERENCE_KEYS,
  allSettings,
  describeAnalysisFailure,
  effectiveCaptureEnabled,
  getLastAnalysisResult,
  getSetting,
  resetPreferences,
  setPreference,
  hookStatus,
  endpointStatus,
} from './settings.js';
import {
  MODEL_API_KEY_ENV_KEY,
  MODEL_ENDPOINT_KEY,
  MODEL_KEY,
  isModelSettingKey,
  resolveModelConfig,
  sanitizedEndpoint,
  setModelSetting,
} from './model-config.js';
import { runReviewSession, type ReviewIO } from './review.js';
import { runHook, type HookName } from './hook.js';
import { DEFAULT_AGENT, agentDefinition, agentSource, parseAgentId, type AgentId } from './agents.js';
import { removePiExtension } from './install.js';

/** `--agent <id>` is accepted by every command that acts on one agent. */
function readAgentArg(args: string[]): { agent: AgentId; rest: string[] } {
  const index = args.findIndex((arg) => arg === '--agent');
  if (index === -1) return { agent: DEFAULT_AGENT, rest: args };
  const parsed = parseAgentId(args[index + 1]);
  if (parsed === null) return { agent: DEFAULT_AGENT, rest: args };
  const rest = [...args.slice(0, index), ...args.slice(index + 2)];
  return { agent: parsed, rest };
}

/** Where an agent's capture is registered: a hooks file, or Pi's extensions directory. */
export function agentTargetPath(agent: AgentId): string {
  if (agent === 'codex') return codexHooksPath();
  if (agent === 'pi') return piExtensionsDir();
  return claudeSettingsPath();
}

export const CLI_VERSION = '0.1.0';

function resolveBinPath(): string {
  return fileURLToPath(new URL('../bin/refluent', import.meta.url));
}

function liveClient(db: DatabaseType): AnalysisClient {
  return analysisClientFor(db);
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`refluent: ${line}\n`);
}

export async function main(argv: string[]): Promise<number> {
  // A closed stdout (`refluent settings | head`, quitting `less` early) is a normal shell
  // idiom, not an error. Any other stdout write failure must still fail the command, so it
  // is rethrown rather than swallowed by having installed a listener.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    case 'version':
    case '--version':
    case '-v':
      out(CLI_VERSION);
      return 0;
    case 'install':
    case 'init':
      return installCommand(rest);
    case 'uninstall': {
      const { agent } = readAgentArg(rest);
      const db = openDatabase();
      const target = agentTargetPath(agent);
      const lines =
        agentDefinition(agent).capture === 'extension'
          ? runUninstall(db, target, agent)
          : runUninstall(db, target, agent);
      for (const line of lines) out(`  ${line}`);
      db.close();
      return 0;
    }
    case 'settings':
    case 'status':
      return settingsCommand(rest);
    case 'review':
      return reviewCommand();
    case 'hook':
      return hookCommand(rest);
    case 'analyze-job':
      return analyzeJobCommand(rest);
    case 'overlay':
      return overlayCommand(rest);
    default:
      fail(`unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  out('refluent — learn English phrasing from your own coding-agent messages.');
  out('');
  out('Commands:');
  out('  refluent install [--yes|--no]      authorize hooks and check the analysis endpoint');
  out('  refluent install --agent <id>       target claude-code (default), codex or pi');
  out('  refluent uninstall [--agent <id>]   remove the hooks (or the Pi extension)');
  out('  refluent overlay install|uninstall  floating macOS panel instead of the terminal status line');
  out('  refluent overlay test               pop up a sample suggestion (drag it to place it)');
  out('  refluent settings [show]           show switches and real enablement state');
  out('  refluent settings set <key> <val>  change a switch');
  out('  refluent settings set model-endpoint <url>   analysis base URL, stored locally');
  out('  refluent settings set model <id>             analysis model id, stored locally');
  out('  refluent settings set model-api-key-env <VAR> read the API key from this env var');
  out('  refluent settings set statusline-original off  drop your own sentence from the status line');
  out('  refluent settings set overlay-duration 20      seconds the overlay stays (6|12|20|30|60)');
  out('  refluent settings reset            restore defaults');
  out('  refluent review                    answer due production questions');
  out('  refluent hook <name> [--agent <id>] hook entrypoint (user-prompt-submit|session-start|statusline)');
  out('  refluent analyze-job <id> [--agent <id>] run one queued analysis job');
  out('');
  out(`Local data: ${dbPath()}`);
  out(`Claude Code settings: ${claudeSettingsPath()}`);
}

async function installCommand(args: string[]): Promise<number> {
  const { agent, rest } = readAgentArg(args);
  const definition = agentDefinition(agent);
  const db = openDatabase();
  const settingsPath = agentTargetPath(agent);
  const assumeYes = rest.includes('--yes') || rest.includes('-y');
  const assumeNo = rest.includes('--no');
  const interactive = process.stdin.isTTY === true;
  const targetLabel = definition.capture === 'extension' ? 'extension' : 'hook location';

  out('refluent install');
  out(`  agent          : ${definition.label} (${agent})`);
  out(`  data directory : ${dataDir()}`);
  out(`  ${targetLabel}  : ${settingsPath}`);
  out(`  scope          : your outgoing ${definition.label} messages only — never agent replies, code or logs.`);
  out('  effect         : the message sent to the agent is never changed or delayed.');
  out('  analysis model : configured via REFLUENT_MODEL_ENDPOINT / REFLUENT_MODEL_API_KEY / REFLUENT_MODEL.');

  let consent = assumeYes;
  if (!assumeYes && !assumeNo) {
    if (!interactive) {
      out('');
      out('Non-interactive shell: re-run with --yes to authorize installation, or --no to decline.');
      db.close();
      return 0;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Install the refluent ${definition.capture === 'extension' ? 'extension' : 'hooks'}? [y/N] `))
      .trim()
      .toLowerCase();
    await rl.close();
    consent = answer === 'y' || answer === 'yes';
  }

  const report = await runInstall(db, {
    consent,
    settingsPath,
    binPath: resolveBinPath(),
    agent,
    overlayInstalled: fs.existsSync(defaultOverlayPaths().plist),
  });
  out('');
  for (const message of report.messages) out(`  ${message}`);
  out('');
  out(`  hook status    : ${report.hookStatus.installed ? (report.hookStatus.loaded ? 'installed_and_loaded' : 'installed_not_loaded') : 'not_installed'}`);
  out(`  endpoint status: ${report.endpoint.status}`);
  out(`  capture        : ${report.captureEnabled ? 'enabled' : 'not enabled'}`);
  out(`  overlay        : ${buildSettingsReport(db).overlay}`);
  if (report.installed && report.endpoint.status === 'ready') {
    out(
      definition.hasInjectableStatusline
        ? `  next           : send your next message in ${definition.label} to see the first suggestion.`
        : `  next           : your ${definition.label} messages are captured; read the suggestions with \`refluent review\`.`,
    );
  }
  db.close();
  return report.installed || !consent ? 0 : 1;
}

async function settingsCommand(args: string[]): Promise<number> {
  const db = openDatabase();
  const sub = args[0] ?? 'show';
  const json = args.includes('--json');

  if (sub === 'set') {
    const key = args[1];
    const value = args[2];
    if (!key || !value) {
      fail('usage: refluent settings set <key> <value>');
      db.close();
      return 1;
    }
    const result = isModelSettingKey(key) ? setModelSetting(db, key, value) : setPreference(db, key, value);
    if (!result.ok) {
      fail(result.error ?? 'could not set value');
      db.close();
      return 1;
    }
    out(`${key} = ${value}`);
    db.close();
    return 0;
  }

  if (sub === 'reset') {
    resetPreferences(db);
    out('All switches restored to defaults.');
    db.close();
    return 0;
  }

  if (sub !== 'show') {
    fail(`unknown settings subcommand: ${sub}`);
    db.close();
    return 1;
  }

  const noProbe = args.includes('--no-probe');
  if (!noProbe) {
    const probe = await probeEndpoint(db);
    recordEndpointProbe(db, probe);
  }

  const report = buildSettingsReport(db);
  if (json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out('refluent settings');
    out('');
    out('Switches (current / default):');
    for (const key of PREFERENCE_KEYS) {
      out(`  ${key}: ${report.preferences[key].value} / ${report.preferences[key].default}`);
    }
    const reasonText: Record<string, string> = {
      preference_off: 'preference is off',
      hook_not_installed: 'hook not installed',
      hook_installed: 'hook installed',
    };
    out('');
    out('Enablement (read-only, real state):');
    out(`  hook status    : ${report.hookStatus}`);
    out(`  endpoint status: ${report.endpointStatus}${report.endpointError ? ` (${report.endpointError})` : ''}`);
    out(`  capture        : ${report.captureEnabled ? 'on' : 'off'} — ${reasonText[report.captureReason] ?? report.captureReason}`);
    out(`  overlay        : ${report.overlay}`);
    out('');
    out('Analysis model (what the hook really resolves):');
    out(`  endpoint       : ${report.model.endpoint}${report.model.endpointSource ? ` (source: ${report.model.endpointSource})` : ''}`);
    out(`  model          : ${report.model.model ?? '(not set)'}${report.model.modelSource ? ` (source: ${report.model.modelSource})` : ''}`);
    out(`  api key        : ${report.model.apiKeyEnvName ? `read from env ${report.model.apiKeyEnvName}` : report.model.apiKeyEnvNameConfigured ? `env ${report.model.apiKeyEnvNameConfigured} is empty or unset` : 'not configured'}`);
    out('');
    out('Last analysis result (read-only):');
    if (report.lastAnalysis) {
      out(`  ${report.lastAnalysis.outcome} at ${report.lastAnalysis.at}${report.lastAnalysis.reason ? ` — ${report.lastAnalysis.reason}` : ''}`);
      if (report.lastAnalysis.outcome === 'failed' && report.lastAnalysis.reason) {
        out(`  why: ${describeAnalysisFailure(report.lastAnalysis.reason)}`);
      }
    } else {
      out('  no analysis yet');
    }
    out('');
    out('Quiet mode overrides statusLine suggestions and the session-start notice.');
    out('statusline-original=auto drops your own sentence on Pi (shared footer) and keeps it elsewhere.');
    out('Commands: refluent settings set <key> <value> | refluent settings reset');
  }
  db.close();
  return 0;
}

export interface SettingsReport {
  preferences: Record<string, { value: string; default: string; allowed: readonly string[] }>;
  hookStatus: 'installed_and_loaded' | 'installed_not_loaded' | 'not_installed';
  endpointStatus: 'ready' | 'not_configured' | 'unreachable';
  endpointError: string;
  captureEnabled: boolean;
  captureReason: string;
  /** Effective analysis config, sanitized: no key value, no URL credentials. */
  model: {
    endpoint: string;
    model: string | null;
    endpointSource: string | null;
    modelSource: string | null;
    apiKeyEnvName: string | null;
    apiKeyEnvNameConfigured: string | null;
  };
  lastAnalysis: { outcome: string; at: string; reason?: string | null } | null;
  overlay: OverlayStatus;
}

export function buildSettingsReport(
  db: DatabaseType,
  options: { overlayInstalled?: boolean } = {},
): SettingsReport {
  const settings = allSettings(db);
  const capture = effectiveCaptureEnabled(db);
  const model = resolveModelConfig(db);
  const preferences: SettingsReport['preferences'] = {};
  for (const key of PREFERENCE_KEYS) {
    preferences[key] = {
      value: settings[key] ?? PREFERENCE_DEFAULTS[key],
      default: PREFERENCE_DEFAULTS[key],
      allowed: ALLOWED_VALUES[key],
    };
  }
  return {
    preferences,
    hookStatus: hookStatus(db),
    endpointStatus: endpointStatus(db),
    endpointError: getSetting(db, 'endpoint_error') ?? '',
    captureEnabled: capture.enabled,
    captureReason: capture.reason,
    model: {
      endpoint: sanitizedEndpoint(model.endpoint),
      model: model.model,
      endpointSource: model.endpointSource,
      modelSource: model.modelSource,
      apiKeyEnvName: model.apiKeyEnvName,
      apiKeyEnvNameConfigured: model.apiKeyEnvNameConfigured,
    },
    lastAnalysis: getLastAnalysisResult(db),
    overlay: overlayStatus(db, options.overlayInstalled ?? fs.existsSync(defaultOverlayPaths().plist)),
  };
}

async function reviewCommand(): Promise<number> {
  const db = openDatabase();
  const client = liveClient(db);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const closed = { value: false };
  rl.on('close', () => {
    closed.value = true;
  });
  const io: ReviewIO = {
    print: (line) => out(line),
    ask: async (prompt) => {
      if (closed.value) return 'q';
      try {
        return await rl.question(prompt);
      } catch {
        return 'q';
      }
    },
  };
  const summary = await runReviewSession(db, client, io);
  await rl.close();
  db.close();
  return summary.exitCode;
}

async function hookCommand(args: string[]): Promise<number> {
  const { agent, rest } = readAgentArg(args);
  const name = rest[0];
  if (name !== 'user-prompt-submit' && name !== 'session-start' && name !== 'statusline') {
    fail('usage: refluent hook <user-prompt-submit|session-start|statusline> [--agent <id>]');
    return 1;
  }
  return runHook(name as HookName, agent);
}

async function analyzeJobCommand(args: string[]): Promise<number> {
  const { agent, rest } = readAgentArg(args);
  const id = Number(rest[0]);
  if (!Number.isInteger(id) || id <= 0) {
    fail('usage: refluent analyze-job <id> [--agent <id>]');
    return 1;
  }
  const db = openDatabase();
  const outcome = await runAnalysis(db, liveClient(db), id, agentSource(agent));
  db.close();
  return outcome.status === 'failed' ? 0 : 0; // analysis failure is never surfaced to the conversation
}

export function overlayOptions(): OverlayInstallOptions {
  const override = process.env.REFLUENT_DATA_DIR?.trim();
  return {
    paths: defaultOverlayPaths(),
    run: runCommand,
    nodePath: stableNodePath(),
    binPath: resolveBinPath(),
    uid: process.getuid?.() ?? 0,
    dataDirOverride: override && override.length > 0 ? override : null,
    claudeSettingsPath: claudeSettingsPath(),
  };
}

export interface OverlayTestOutcome {
  ok: boolean;
  message: string;
}

/**
 * `overlay test` must only queue a sample for an overlay that is running right now: a
 * stopped or not-installed overlay would leave the request queued, and it would pop up
 * — out of context — whenever a runner next starts, possibly days later. The request is
 * written only in the `ok` branch, so callers never need to remember to check first.
 */
export function performOverlayTest(db: DatabaseType, status: OverlayStatus, logPath: string): OverlayTestOutcome {
  if (status === 'not_installed') {
    return { ok: false, message: 'the overlay is not installed; run `refluent overlay install` first.' };
  }
  if (status === 'stopped') {
    return {
      ok: false,
      message: `the overlay is installed but not running; see ${logPath}, or run \`refluent overlay install\` again to restart it.`,
    };
  }
  requestTestOverlay(db);
  return { ok: true, message: 'Sent a sample suggestion to the overlay.' };
}

async function overlayCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const db = openDatabase();
  try {
    if (sub === 'install' || sub === 'uninstall') {
      const result = sub === 'install' ? installOverlay(db, overlayOptions()) : uninstallOverlay(db, overlayOptions());
      for (const line of result.messages) {
        if (result.ok) out(`  ${line}`);
        else fail(line);
      }
      return result.ok ? 0 : 1;
    }
    if (sub === 'run') {
      const paths = defaultOverlayPaths();
      return await runOverlay(db, paths.binary, (line) => fs.appendFileSync(paths.log, `${line}\n`));
    }
    if (sub === 'test') {
      const status = buildSettingsReport(db).overlay;
      const outcome = performOverlayTest(db, status, defaultOverlayPaths().log);
      if (outcome.ok) {
        out(outcome.message);
        return 0;
      }
      fail(outcome.message);
      return 1;
    }
    fail('usage: refluent overlay <install|uninstall|run|test>');
    return 1;
  } finally {
    db.close();
  }
}

export { captureMessage };