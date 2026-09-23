import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { claudeSettingsPath, dataDir, dbPath } from './config.js';
import { openDatabase, type DatabaseType } from './db.js';
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
      const db = openDatabase();
      for (const line of runUninstall(db, claudeSettingsPath())) out(`  ${line}`);
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
  out('  refluent uninstall                  remove the hooks and restore your own statusLine');
  out('  refluent settings [show]           show switches and real enablement state');
  out('  refluent settings set <key> <val>  change a switch');
  out('  refluent settings set model-endpoint <url>   analysis base URL, stored locally');
  out('  refluent settings set model <id>             analysis model id, stored locally');
  out('  refluent settings set model-api-key-env <VAR> read the API key from this env var');
  out('  refluent settings reset            restore defaults');
  out('  refluent review                    answer due production questions');
  out('  refluent hook <name>               hook entrypoint (user-prompt-submit|session-start|statusline)');
  out('  refluent analyze-job <id>          run one queued analysis job');
  out('');
  out(`Local data: ${dbPath()}`);
  out(`Claude Code settings: ${claudeSettingsPath()}`);
}

async function installCommand(args: string[]): Promise<number> {
  const db = openDatabase();
  const settingsPath = claudeSettingsPath();
  const assumeYes = args.includes('--yes') || args.includes('-y');
  const assumeNo = args.includes('--no');
  const interactive = process.stdin.isTTY === true;

  out('refluent install');
  out(`  data directory : ${dataDir()}`);
  out(`  hook location  : ${settingsPath}`);
  out('  scope          : your outgoing Claude Code messages only — never agent replies, code or logs.');
  out('  effect         : the message sent to the agent is never changed or delayed.');
  out('  analysis model : configured via REFLUENT_MODEL_ENDPOINT / REFLUENT_MODEL_API_KEY / REFLUENT_MODEL.');

  let consent = assumeYes;
  if (!assumeYes && !assumeNo) {
    if (!interactive) {
      out('');
      out('Non-interactive shell: re-run with --yes to authorize hook installation, or --no to decline.');
      db.close();
      return 0;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Install the refluent hooks? [y/N] ')).trim().toLowerCase();
    await rl.close();
    consent = answer === 'y' || answer === 'yes';
  }

  const report = await runInstall(db, {
    consent,
    settingsPath,
    binPath: resolveBinPath(),
  });
  out('');
  for (const message of report.messages) out(`  ${message}`);
  out('');
  out(`  hook status    : ${report.hookStatus.installed ? (report.hookStatus.loaded ? 'installed_and_loaded' : 'installed_not_loaded') : 'not_installed'}`);
  out(`  endpoint status: ${report.endpoint.status}`);
  out(`  capture        : ${report.captureEnabled ? 'enabled' : 'not enabled'}`);
  if (report.installed && report.endpoint.status === 'ready') {
    out('  next           : send your next message in Claude Code to see the first suggestion.');
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
}

export function buildSettingsReport(db: DatabaseType): SettingsReport {
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
  const name = args[0];
  if (name !== 'user-prompt-submit' && name !== 'session-start' && name !== 'statusline') {
    fail('usage: refluent hook <user-prompt-submit|session-start|statusline>');
    return 1;
  }
  return runHook(name as HookName);
}

async function analyzeJobCommand(args: string[]): Promise<number> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) {
    fail('usage: refluent analyze-job <id>');
    return 1;
  }
  const db = openDatabase();
  const outcome = await runAnalysis(db, liveClient(db), id);
  db.close();
  return outcome.status === 'failed' ? 0 : 0; // analysis failure is never surfaced to the conversation
}

export { captureMessage };