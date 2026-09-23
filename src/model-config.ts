import type { ModelEnv } from './config.js';
import type { DatabaseType } from './db.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Durable, non-secret model configuration.
 *
 * Why this exists: the analysis model was reachable only through process
 * environment variables. Claude Code runs its hooks as child processes of the
 * agent, so a variable that exists in a terminal profile is invisible to the
 * hook unless the agent itself inherited it — which produced a generic
 * "analysis unavailable" with no way to see that nothing was configured.
 *
 * The endpoint and model are not secrets, so they are persisted locally and
 * resolved at every entrypoint (hook, review, analyze-job). The API key is
 * never stored: it is read from `REFLUENT_MODEL_API_KEY`, or from the
 * environment variable named by the `model-api-key-env` setting, so a key that
 * already lives in the agent's environment can be reused in place.
 */

export const MODEL_ENDPOINT_KEY = 'model-endpoint';
export const MODEL_KEY = 'model';
export const MODEL_API_KEY_ENV_KEY = 'model-api-key-env';

export const MODEL_SETTING_KEYS = [MODEL_ENDPOINT_KEY, MODEL_KEY, MODEL_API_KEY_ENV_KEY] as const;
export type ModelSettingKey = (typeof MODEL_SETTING_KEYS)[number];

/** `none` clears a stored model setting; it is never stored as a value. */
export const CLEAR_TOKEN = 'none';

export type ConfigSource = 'environment' | 'local settings';

export interface ResolvedModelConfig {
  /** What the HTTP client needs. Null until both endpoint and model are known. */
  env: ModelEnv | null;
  endpoint: string | null;
  model: string | null;
  endpointSource: ConfigSource | null;
  modelSource: ConfigSource | null;
  /** Name of the environment variable the key was read from; never the value. */
  apiKeyEnvName: string | null;
  /** Where the key would be looked up even when it is currently unset. */
  apiKeyEnvNameConfigured: string | null;
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

export function isModelSettingKey(key: string): key is ModelSettingKey {
  return (MODEL_SETTING_KEYS as readonly string[]).includes(key);
}

/** Trim and drop trailing slashes so `/v1` and `/v1/` behave identically. */
export function normalizeEndpoint(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** The value actually stored: a normalized form, or '' for a cleared setting. */
  stored?: string;
}

export function validateModelSetting(key: ModelSettingKey, value: string): ValidationResult {
  const raw = value?.trim() ?? '';
  if (!raw || raw.includes('\n') || raw.includes('\r')) {
    return { ok: false, error: `invalid value for ${key}: must be a single non-empty line` };
  }
  if (raw === CLEAR_TOKEN) return { ok: true, stored: '' };

  if (key === MODEL_ENDPOINT_KEY) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: `invalid value for ${key}: not a URL (example: https://openrouter.ai/api/v1)` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `invalid value for ${key}: URL must use http or https` };
    }
    // A base URL needs neither credentials nor a query string. Rejecting them
    // keeps a value that is stored and printed from silently carrying a secret.
    if (url.username || url.password) {
      return { ok: false, error: `invalid value for ${key}: remove the username/password from the URL` };
    }
    if (url.search || url.hash) {
      return { ok: false, error: `invalid value for ${key}: remove the query string or fragment (use the plain base URL)` };
    }
    if (raw.length > 300) return { ok: false, error: `invalid value for ${key}: too long` };
    return { ok: true, stored: normalizeEndpoint(raw) ?? '' };
  }

  if (key === MODEL_KEY) {
    if (raw.length > 200) return { ok: false, error: `invalid value for ${key}: too long` };
    return { ok: true, stored: raw };
  }

  if (!ENV_VAR_NAME.test(raw)) {
    return {
      ok: false,
      error: `invalid value for ${key}: must be an environment variable name such as OPENROUTER_API_KEY (use ${CLEAR_TOKEN} to clear)`,
    };
  }
  return { ok: true, stored: raw };
}

export interface SetModelSettingResult {
  ok: boolean;
  error?: string;
}

export function setModelSetting(db: DatabaseType, key: string, value: string): SetModelSettingResult {
  if (!isModelSettingKey(key)) return { ok: false, error: `unknown setting: ${key}` };
  const validated = validateModelSetting(key, value);
  if (!validated.ok) return { ok: false, error: validated.error };
  setSetting(db, key, validated.stored ?? '');
  return { ok: true };
}

function stored(db: DatabaseType, key: ModelSettingKey): string | null {
  const value = getSetting(db, key)?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Effective configuration for this process. Environment variables win over
 * stored settings so a one-off `REFLUENT_MODEL=... refluent review` still
 * overrides what is persisted.
 */
export function resolveModelConfig(
  db: DatabaseType,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelConfig {
  const envEndpoint = normalizeEndpoint(env.REFLUENT_MODEL_ENDPOINT);
  const envModel = env.REFLUENT_MODEL?.trim() || null;
  const storedEndpoint = normalizeEndpoint(stored(db, MODEL_ENDPOINT_KEY));
  const storedModel = stored(db, MODEL_KEY);

  const endpoint = envEndpoint ?? storedEndpoint;
  const model = envModel ?? storedModel;

  const configuredKeyEnv = stored(db, MODEL_API_KEY_ENV_KEY);
  const directKey = env.REFLUENT_MODEL_API_KEY?.trim();
  let apiKey: string | null = null;
  let apiKeyEnvName: string | null = null;
  if (directKey) {
    apiKey = directKey;
    apiKeyEnvName = 'REFLUENT_MODEL_API_KEY';
  } else if (configuredKeyEnv) {
    const indirect = env[configuredKeyEnv]?.trim();
    if (indirect) {
      apiKey = indirect;
      apiKeyEnvName = configuredKeyEnv;
    }
  }

  return {
    env: endpoint && model ? { endpoint, model, apiKey } : null,
    endpoint,
    model,
    endpointSource: envEndpoint ? 'environment' : storedEndpoint ? 'local settings' : null,
    modelSource: envModel ? 'environment' : storedModel ? 'local settings' : null,
    apiKeyEnvName,
    apiKeyEnvNameConfigured: configuredKeyEnv,
  };
}

/** A URL safe to print: credentials, query and fragment are dropped. */
export function sanitizedEndpoint(endpoint: string | null): string {
  if (!endpoint) return '(not set)';
  try {
    const url = new URL(endpoint);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return '(invalid URL)';
  }
}
