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