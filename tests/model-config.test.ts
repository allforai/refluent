import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb, resultFor } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import {
  MODEL_API_KEY_ENV_KEY,
  MODEL_ENDPOINT_KEY,
  MODEL_KEY,
  resolveModelConfig,
  sanitizedEndpoint,
  setModelSetting,
  validateModelSetting,
} from '../src/model-config.js';
import { HttpAnalysisClient, analysisClientFor } from '../src/analysis/http.js';
import { NullAnalysisClient } from '../src/analysis/stub.js';
import { probeEndpoint } from '../src/install.js';
import { captureMessage, runAnalysis } from '../src/capture.js';
import type { AnalysisClient, AnalysisFailure } from '../src/analysis/types.js';
import type { AnalysisResult } from '../src/issue-classes.js';
import { handleUserPromptSubmit } from '../src/hook.js';
import { getLastAnalysisResult, setSetting } from '../src/settings.js';

let db: DatabaseType;
const REFLUENT_VARS = ['REFLUENT_MODEL_ENDPOINT', 'REFLUENT_MODEL', 'REFLUENT_MODEL_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  db = memoryDb();
  for (const key of REFLUENT_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of REFLUENT_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete process.env.OPENROUTER_API_KEY;
  vi.unstubAllGlobals();
  db.close();
});

function storeModelConfig(endpoint = 'https://openrouter.ai/api/v1', model = 'openai/gpt-4o-mini'): void {
  expect(setModelSetting(db, MODEL_ENDPOINT_KEY, endpoint).ok).toBe(true);
  expect(setModelSetting(db, MODEL_KEY, model).ok).toBe(true);
}

describe('model config: resolution survives the hook environment', () => {
  it('resolves stored settings when the environment is empty (the hook-child case)', () => {
    storeModelConfig();
    const resolved = resolveModelConfig(db, {});
    expect(resolved.env).toEqual({ endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', apiKey: null });
    expect(resolved.endpointSource).toBe('local settings');
    expect(resolved.modelSource).toBe('local settings');
  });

  it('lets an explicit environment override the stored settings', () => {
    storeModelConfig();
    const resolved = resolveModelConfig(db, {
      REFLUENT_MODEL_ENDPOINT: 'http://127.0.0.1:11434/v1',
      REFLUENT_MODEL: 'local-model',
    });
    expect(resolved.env?.endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(resolved.endpointSource).toBe('environment');
  });

  it('reads the key from the variable named by model-api-key-env, without storing the secret', () => {
    storeModelConfig();
    expect(setModelSetting(db, MODEL_API_KEY_ENV_KEY, 'OPENROUTER_API_KEY').ok).toBe(true);
    const resolved = resolveModelConfig(db, { OPENROUTER_API_KEY: 'sk-test-value' });
    expect(resolved.env?.apiKey).toBe('sk-test-value');
    expect(resolved.apiKeyEnvName).toBe('OPENROUTER_API_KEY');
    // The name is stored; the value never is.
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'model-api-key-env'").get() as { value: string };
    expect(stored.value).toBe('OPENROUTER_API_KEY');
  });

  it('reports the configured variable name when it is empty, so the gap is visible', () => {
    storeModelConfig();
    setModelSetting(db, MODEL_API_KEY_ENV_KEY, 'OPENROUTER_API_KEY');
    const resolved = resolveModelConfig(db, {});
    expect(resolved.env?.apiKey).toBeNull();
    expect(resolved.apiKeyEnvName).toBeNull();
    expect(resolved.apiKeyEnvNameConfigured).toBe('OPENROUTER_API_KEY');
  });

  it('is unconfigured when neither endpoint nor model is known', () => {
    expect(resolveModelConfig(db, {}).env).toBeNull();
  });

  it('rejects invalid model settings and accepts "none" as a clear', () => {
    expect(validateModelSetting(MODEL_ENDPOINT_KEY, 'not a url').ok).toBe(false);
    expect(validateModelSetting(MODEL_ENDPOINT_KEY, 'ftp://example.com/v1').ok).toBe(false);
    expect(validateModelSetting(MODEL_API_KEY_ENV_KEY, 'not-a-name').ok).toBe(false);
    expect(validateModelSetting(MODEL_KEY, '   ').ok).toBe(false);

    storeModelConfig();
    expect(setModelSetting(db, MODEL_ENDPOINT_KEY, 'none').ok).toBe(true);
    expect(resolveModelConfig(db, {}).env).toBeNull();
  });

  it('refuses an endpoint that would store a secret in a non-secret field', () => {
    const withUserInfo = validateModelSetting(MODEL_ENDPOINT_KEY, 'https://user:secret@example.com/v1');
    expect(withUserInfo.ok).toBe(false);
    expect(withUserInfo.error).toContain('username/password');

    const withQuery = validateModelSetting(MODEL_ENDPOINT_KEY, 'https://example.com/v1?api_key=secret');
    expect(withQuery.ok).toBe(false);
    expect(withQuery.error).toContain('query string');

    // The rejected values never reach stored state.
    expect(setModelSetting(db, MODEL_ENDPOINT_KEY, 'https://user:secret@example.com/v1').ok).toBe(false);
    expect(resolveModelConfig(db, {}).endpoint).toBeNull();
  });

  it('never prints credentials embedded in the endpoint', () => {
    expect(sanitizedEndpoint('https://user:secret@example.com/v1?token=abc')).toBe('https://example.com/v1');
    expect(sanitizedEndpoint(null)).toBe('(not set)');
  });
});

describe('model config: a malformed model reply is retried once', () => {
  /** Replies with each scripted outcome in turn: a result, or a failure reason. */
  function scriptedClient(script: Array<AnalysisResult | AnalysisFailure>): AnalysisClient & { calls: number } {
    const client = {
      calls: 0,
      lastFailure: null as AnalysisFailure | null,
      async analyze() {
        const next = script[Math.min(client.calls, script.length - 1)]!;
        client.calls += 1;
        if (typeof next === 'string') {
          client.lastFailure = next;
          return null;
        }
        client.lastFailure = null;
        return next;
      },
      async generateQuestion() {
        return null;
      },
    };
    return client;
  }

  it('recovers the suggestion when the second reply is valid', async () => {
    const captured = captureMessage(db, { rawText: 'Can you help me check this bug?' });
    const client = scriptedClient(['invalid_response', resultFor({ canonicalForm: 'check this bug' })]);
    const outcome = await runAnalysis(db, client, captured.jobId);
    expect(client.calls).toBe(2);
    expect(outcome.status).not.toBe('failed');
    expect(getLastAnalysisResult(db)?.outcome).toBe('suggestion_emitted');
  });

  it('records invalid_response when the retry is malformed too', async () => {
    const captured = captureMessage(db, { rawText: 'Can you help me check this bug?' });
    const client = scriptedClient(['invalid_response', 'invalid_response', resultFor({ canonicalForm: 'x' })]);
    const outcome = await runAnalysis(db, client, captured.jobId);
    expect(client.calls).toBe(2);
    expect(outcome.reason).toBe('invalid_response');
  });

  it('does not retry any other failure', async () => {
    for (const failure of ['not_configured', 'auth_rejected', 'timeout', 'rate_limited', 'http_error_502'] as const) {
      const captured = captureMessage(db, { rawText: `Can you help me check this ${failure} bug?` });
      const client = scriptedClient([failure, resultFor({ canonicalForm: 'x' })]);
      const outcome = await runAnalysis(db, client, captured.jobId);
      expect(client.calls).toBe(1);
      expect(outcome.reason).toBe(failure);
    }
  });
});

describe('model config: failures are distinguishable', () => {
  it('records not_configured instead of a generic analysis_unavailable', async () => {
    const captured = captureMessage(db, { rawText: 'Can you help me check this bug?' });
    const outcome = await runAnalysis(db, new NullAnalysisClient(), captured.jobId);
    expect(outcome.reason).toBe('not_configured');
    expect(getLastAnalysisResult(db)?.reason).toBe('not_configured');
    const job = db.prepare('SELECT error FROM analysis_jobs WHERE id = ?').get(captured.jobId) as { error: string };
    expect(job.error).toBe('not_configured');
  });

  it('classifies transport and HTTP failures without echoing response bodies', async () => {
    const client = new HttpAnalysisClient({ endpoint: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k' });
    const request = { filteredText: 'Can you help me check this bug?', filterVersion: 'v' };

    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret upstream detail', { status: 401 })));
    await client.analyze(request);
    expect(client.lastFailure).toBe('auth_rejected');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    await client.analyze(request);
    expect(client.lastFailure).toBe('rate_limited');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    await client.analyze(request);
    expect(client.lastFailure).toBe('http_error_502');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));
    await client.analyze(request);
    expect(client.lastFailure).toBe('timeout');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await client.analyze(request);
    expect(client.lastFailure).toBe('network_error');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'not json' } }] }),
      { status: 200 },
    )));
    await client.analyze(request);
    expect(client.lastFailure).toBe('invalid_response');
  });

  it('keeps the endpoint probe error free of the server response body', async () => {
    const client = new HttpAnalysisClient({ endpoint: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'upstream detail that may contain a key: sk-live-abcdefghijklmnop',
      { status: 500 },
    )));
    const probe = await client.probe();
    expect(probe.status).toBe('unreachable');
    expect(probe.error).toBe('HTTP 500');
    expect(probe.error).not.toContain('sk-live');
  });
});

describe('model config: one resolver for every entrypoint', () => {
  it('gives the hook, review/analyze-job and the install probe the same client', async () => {
    expect(analysisClientFor(db, {})).toBeInstanceOf(NullAnalysisClient);
    storeModelConfig();

    const client = analysisClientFor(db, {});
    expect(client).toBeInstanceOf(HttpAnalysisClient);
    expect((client as HttpAnalysisClient).model).toBe('openai/gpt-4o-mini');

    // install's probe reaches the stored endpoint with an empty environment.
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      return new Response('{}', { status: 200 });
    }));
    const probe = await probeEndpoint(db, {});
    expect(probe.status).toBe('ready');
    expect(seen[0]).toBe('https://openrouter.ai/api/v1/models');
  });
});

describe('model config: the installed hook path works with an empty environment', () => {
  it('analyzes a synthetic sentence using the stored endpoint and the key named by env', async () => {
    storeModelConfig();
    setModelSetting(db, MODEL_API_KEY_ENV_KEY, 'OPENROUTER_API_KEY');
    process.env.OPENROUTER_API_KEY = 'sk-test-value';
    setSetting(db, 'hook_installed', 'true');

    let authorization: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      authorization = (init.headers as Record<string, string>).authorization;
      const content = JSON.stringify({
        issue: { class: 'grammar_error', severity: 'medium', span: 'try', explanation: 'wrong verb form' },
        rewrite: 'I have already tried to fix it.',
        reason: 'use the past participle after "have"',
        knowledge_point: {
          kind: 'grammar-rule',
          canonical_form: 'have + past participle',
          explanation: 'the perfect tense needs the past participle',
          rule_key: 'perfect-tense',
        },
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));

    // No client injected: this is the path the real hook takes.
    const result = await handleUserPromptSubmit(
      JSON.stringify({ prompt: 'I have already try to fix it, can you check?', message_id: 'evt-config' }),
      { db, inlineAnalysis: true },
    );

    expect(result.captured).toBe(true);
    expect(getLastAnalysisResult(db)?.outcome).toBe('suggestion_emitted');
    const kp = db.prepare('SELECT canonical_form FROM knowledge_points').all() as Array<{ canonical_form: string }>;
    expect(kp).toHaveLength(1);
    expect(kp[0].canonical_form).toBe('have + past participle');
    // The key came from the variable named in settings, not from a stored secret.
    expect(authorization).toBe('Bearer sk-test-value');
  });
});
