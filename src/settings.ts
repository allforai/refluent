import { nowIso } from './config.js';
import { SETTING_DEFAULTS, type DatabaseType } from './db.js';

export type SettingKey = string;

export const PREFERENCE_KEYS = [
  'capture-enabled',
  'statusline-suggestion',
  'statusline-original',
  'session-start-review',
  'quiet-mode',
  'reminder-channel',
  'overlay-duration',
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const PREFERENCE_DEFAULTS: Readonly<Record<PreferenceKey, string>> = {
  'capture-enabled': SETTING_DEFAULTS['capture-enabled'],
  'statusline-suggestion': SETTING_DEFAULTS['statusline-suggestion'],
  'statusline-original': SETTING_DEFAULTS['statusline-original'],
  'session-start-review': SETTING_DEFAULTS['session-start-review'],
  'quiet-mode': SETTING_DEFAULTS['quiet-mode'],
  'reminder-channel': SETTING_DEFAULTS['reminder-channel'],
  'overlay-duration': SETTING_DEFAULTS['overlay-duration'],
};

export const ALLOWED_VALUES: Readonly<Record<PreferenceKey, readonly string[]>> = {
  'capture-enabled': ['on', 'off'],
  'statusline-suggestion': ['on', 'off'],
  'statusline-original': ['auto', 'on', 'off'],
  'session-start-review': ['on', 'off'],
  'quiet-mode': ['on', 'off'],
  'reminder-channel': ['terminal'],
  'overlay-duration': ['6', '12', '20', '30', '60'],
};

export function getSetting(db: DatabaseType, key: SettingKey): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DatabaseType, key: SettingKey, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function allSettings(db: DatabaseType): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function isPreferenceKey(key: string): key is PreferenceKey {
  return (PREFERENCE_KEYS as readonly string[]).includes(key);
}

export interface SetPreferenceResult {
  ok: boolean;
  error?: string;
}

/** Validates then persists one preference. A rejected value never changes stored state. */
export function setPreference(db: DatabaseType, key: string, value: string): SetPreferenceResult {
  if (!isPreferenceKey(key)) {
    return { ok: false, error: `unknown setting: ${key}` };
  }
  const allowed = ALLOWED_VALUES[key];
  if (!allowed.includes(value)) {
    return { ok: false, error: `invalid value for ${key}: ${value} (allowed: ${allowed.join(', ')})` };
  }
  setSetting(db, key, value);
  return { ok: true };
}

export function resetPreferences(db: DatabaseType): void {
  for (const key of PREFERENCE_KEYS) {
    setSetting(db, key, PREFERENCE_DEFAULTS[key]);
  }
}

export function quietModeOn(db: DatabaseType): boolean {
  return getSetting(db, 'quiet-mode') === 'on';
}

export interface CaptureEnablement {
  enabled: boolean;
  reason: string;
}

/**
 * The capture switch shows an *effective* value derived from the preference and
 * the install state. Whether Claude Code really runs the hook is reported
 * separately by `hookStatus`, from a timestamp the hook itself writes.
 */
export function effectiveCaptureEnabled(db: DatabaseType): CaptureEnablement {
  const pref = getSetting(db, 'capture-enabled') ?? 'off';
  if (pref !== 'on') return { enabled: false, reason: 'preference_off' };
  if (getSetting(db, 'hook_installed') !== 'true') return { enabled: false, reason: 'hook_not_installed' };
  return { enabled: true, reason: 'hook_installed' };
}

/** Called by the hook process itself: the only proof that Claude Code loaded it. */
export function markHookSeen(db: DatabaseType, at: string = nowIso()): void {
  setSetting(db, 'hook_seen_at', at);
}

export interface LastAnalysisResult {
  outcome: 'suggestion_emitted' | 'no_improvement' | 'skipped_filtered' | 'failed';
  at: string;
  reason?: string | null;
}

export function setLastAnalysisResult(db: DatabaseType, result: LastAnalysisResult): void {
  setSetting(db, 'last_analysis_result', JSON.stringify(result));
}

export function getLastAnalysisResult(db: DatabaseType): LastAnalysisResult | null {
  const raw = getSetting(db, 'last_analysis_result');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LastAnalysisResult;
    return typeof parsed?.outcome === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Plain-language explanation of a recorded analysis failure. The stored reason
 * is already sanitized (no response bodies, no payloads), so this is what turns
 * "analysis unavailable" into a step the user can take.
 */
export function describeAnalysisFailure(reason: string): string {
  if (reason === 'not_configured') {
    return 'no analysis model is configured for the hook — run `refluent settings set model-endpoint <url>`, `refluent settings set model <id>`, and `refluent settings set model-api-key-env <ENV_VAR>`';
  }
  if (reason === 'auth_rejected') {
    return 'the endpoint rejected the credentials (HTTP 401/403) — check the key named by model-api-key-env';
  }
  if (reason === 'rate_limited') {
    return 'the endpoint rate-limited the request (HTTP 429) — retry later or use a slower/smaller model';
  }
  if (reason === 'timeout') {
    return 'the endpoint did not answer within 8s — a faster model or a closer endpoint is needed';
  }
  if (reason === 'network_error') return 'the endpoint could not be reached — check the URL and network';
  if (reason === 'empty_response') return 'the endpoint returned an empty message';
  if (reason === 'invalid_response') {
    return 'the endpoint replied with something that is not the expected JSON object — the model may not support json_object responses';
  }
  const http = /^http_error_(\d{3})$/.exec(reason);
  if (http) {
    return `the endpoint replied HTTP ${http[1]} — check the base URL (no /chat/completions), the model id, and billing`;
  }
  return 'analysis did not produce a result';
}

export function hookStatus(db: DatabaseType): 'installed_and_loaded' | 'installed_not_loaded' | 'not_installed' {
  if (getSetting(db, 'hook_installed') !== 'true') return 'not_installed';
  return (getSetting(db, 'hook_seen_at') ?? '') !== '' ? 'installed_and_loaded' : 'installed_not_loaded';
}

export function endpointStatus(db: DatabaseType): 'ready' | 'not_configured' | 'unreachable' {
  const value = getSetting(db, 'endpoint_status');
  return value === 'ready' || value === 'unreachable' ? value : 'not_configured';
}