import { nowIso } from './config.js';
import { SETTING_DEFAULTS, type DatabaseType } from './db.js';

export type SettingKey = string;

export const PREFERENCE_KEYS = [
  'capture-enabled',
  'statusline-suggestion',
  'session-start-review',
  'quiet-mode',
  'reminder-channel',
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const PREFERENCE_DEFAULTS: Readonly<Record<PreferenceKey, string>> = {
  'capture-enabled': SETTING_DEFAULTS['capture-enabled'],
  'statusline-suggestion': SETTING_DEFAULTS['statusline-suggestion'],
  'session-start-review': SETTING_DEFAULTS['session-start-review'],
  'quiet-mode': SETTING_DEFAULTS['quiet-mode'],
  'reminder-channel': SETTING_DEFAULTS['reminder-channel'],
};

export const ALLOWED_VALUES: Readonly<Record<PreferenceKey, readonly string[]>> = {
  'capture-enabled': ['on', 'off'],
  'statusline-suggestion': ['on', 'off'],
  'session-start-review': ['on', 'off'],
  'quiet-mode': ['on', 'off'],
  'reminder-channel': ['terminal'],
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

export function hookStatus(db: DatabaseType): 'installed_and_loaded' | 'installed_not_loaded' | 'not_installed' {
  if (getSetting(db, 'hook_installed') !== 'true') return 'not_installed';
  return (getSetting(db, 'hook_seen_at') ?? '') !== '' ? 'installed_and_loaded' : 'installed_not_loaded';
}

export function endpointStatus(db: DatabaseType): 'ready' | 'not_configured' | 'unreachable' {
  const value = getSetting(db, 'endpoint_status');
  return value === 'ready' || value === 'unreachable' ? value : 'not_configured';
}