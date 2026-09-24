import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runtime paths and environment boundary for refluent.
 *
 * Everything learner-owned lives under one user-level directory, so knowledge
 * points accumulate across every project and never land inside a repository.
 * Deleting it removes all local data (no server copy exists).
 */
export function dataDir(): string {
  const override = process.env.REFLUENT_DATA_DIR?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), '.refluent');
}

export const DB_FILENAME = 'analysis-and-data.sqlite';

export function dbPath(): string {
  return path.join(dataDir(), DB_FILENAME);
}

/** Claude Code user-level settings file that holds the hook registration. */
export function claudeSettingsPath(): string {
  const override = process.env.REFLUENT_CLAUDE_SETTINGS?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Codex user-level hooks file. Same `{hooks: {Event: [{hooks: [...]}]}}` shape as Claude Code.
 *
 * It is resolved against `CODEX_HOME`, not the literal `~/.codex`: a manager like Orca
 * runs Codex with a per-account home, and a hook written to `~/.codex/hooks.json` is never
 * read. `~/.codex` is only the fallback when `CODEX_HOME` is unset.
 */
export function codexHooksPath(): string {
  const override = process.env.REFLUENT_CODEX_SETTINGS?.trim();
  if (override && override.length > 0) return override;
  const home = process.env.CODEX_HOME?.trim();
  return home && home.length > 0
    ? path.join(home, 'hooks.json')
    : path.join(os.homedir(), '.codex', 'hooks.json');
}

/** Directory Pi loads personal extensions from. */
export function piExtensionsDir(): string {
  const override = process.env.REFLUENT_PI_EXTENSIONS?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), '.pi', 'agent', 'extensions');
}

export function nowIso(at: Date = new Date()): string {
  return at.toISOString();
}

export interface ModelEnv {
  endpoint: string;
  apiKey: string | null;
  model: string;
}

/** Reads the three analysis-model env vars. Returns null when the endpoint or model is absent. */
export function readModelEnv(env: NodeJS.ProcessEnv = process.env): ModelEnv | null {
  const endpoint = env.REFLUENT_MODEL_ENDPOINT?.trim();
  const model = env.REFLUENT_MODEL?.trim();
  if (!endpoint || !model) return null;
  const apiKey = env.REFLUENT_MODEL_API_KEY?.trim();
  return { endpoint, apiKey: apiKey && apiKey.length > 0 ? apiKey : null, model };
}
/**
 * The node written into hook commands and the overlay's LaunchAgent. `process.execPath`
 * is the resolved binary, which under Homebrew is a versioned Cellar path that the next
 * `brew upgrade` deletes, breaking every hook. A `node` on PATH that resolves to the same
 * binary (such as /opt/homebrew/bin/node) keeps working across upgrades.
 */
export function stableNodePath(
  execPath: string = process.execPath,
  pathEnv: string = process.env.PATH ?? '',
  realpath: (file: string) => string = (file) => fs.realpathSync(file),
): string {
  let target: string;
  try {
    target = realpath(execPath);
  } catch {
    return execPath;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, 'node');
    if (candidate === execPath) continue;
    try {
      if (realpath(candidate) === target) return candidate;
    } catch {
      // Not on this PATH entry.
    }
  }
  return execPath;
}
