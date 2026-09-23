import { readModelEnv, type ModelEnv } from '../config.js';
import { resolveModelConfig } from '../model-config.js';
import type { DatabaseType } from '../db.js';
import { NullAnalysisClient } from './stub.js';
import {
  ANALYSIS_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  validateAnalysisResult,
  type AnalysisResult,
} from '../issue-classes.js';
import type {
  AnalysisClient,
  AnalysisFailure,
  AnalyzeRequest,
  GenerateQuestionRequest,
  ReviewQuestionSpec,
  ReviewQuestionType,
} from './types.js';

export const ANALYSIS_TIMEOUT_MS = 8000;
export const PROBE_TIMEOUT_MS = 3000;

/**
 * The single place every entrypoint builds its model client — the Claude Code
 * hook, the detached `analyze-job` child, `review` and `install`. They must not
 * disagree about what is configured, which is exactly how the hook ended up
 * analyzing nothing while an interactive shell probed "ready".
 */
export function analysisClientFor(
  db: DatabaseType,
  env: NodeJS.ProcessEnv = process.env,
): AnalysisClient {
  return HttpAnalysisClient.fromConfig(resolveModelConfig(db, env).env) ?? new NullAnalysisClient();
}

export type EndpointStatus = 'ready' | 'not_configured' | 'unreachable';

export interface EndpointProbe {
  status: EndpointStatus;
  error: string | null;
  checkedAt: string;
}

interface ChatChoice {
  message?: { content?: unknown };
}

/**
 * Real HTTP client for an OpenAI-compatible endpoint.
 *
 * Privacy boundary: `analyze` sends only the `filteredText` it is given. The
 * guarantee lives in `filterNaturalLanguage`, which every caller runs first;
 * `raw_text` never reaches this class.
 */
export class HttpAnalysisClient implements AnalysisClient {
  /** Sanitized cause of the most recent failed call; never carries a payload. */
  lastFailure: AnalysisFailure | null = null;

  constructor(private readonly env: ModelEnv) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpAnalysisClient | null {
    const config = readModelEnv(env);
    return config ? new HttpAnalysisClient(config) : null;
  }

  /** Builds a client from an already-resolved config (environment or stored settings). */
  static fromConfig(config: ModelEnv | null): HttpAnalysisClient | null {
    return config ? new HttpAnalysisClient(config) : null;
  }

  get model(): string {
    return this.env.model;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalysisResult | null> {
    const content = request.filteredText;
    if (typeof content !== 'string' || content.length === 0) {
      this.lastFailure = 'empty_response';
      return null;
    }
    const body = {
      model: this.env.model,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: 'json_object' },
    };
    const parsed = await this.post(body);
    if (parsed.value === null) {
      this.lastFailure = parsed.failure;
      return null;
    }
    const validated = validateAnalysisResult(parsed.value);
    if (validated === null) {
      this.lastFailure = 'invalid_response';
      return null;
    }
    this.lastFailure = null;
    return { ...validated, model: this.env.model, model_version: this.env.model };
  }

  async generateQuestion(request: GenerateQuestionRequest): Promise<ReviewQuestionSpec | null> {
    const payload = {
      kind: request.knowledgePoint.kind,
      canonical_form: request.knowledgePoint.canonicalForm,
      explanation: request.knowledgePoint.explanation,
      rule_key: request.knowledgePoint.ruleKey,
      type: request.type,
      context: request.contextSentence ?? null,
    };
    const body = {
      model: this.env.model,
      messages: [
        { role: 'system', content: QUESTION_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      temperature: 0,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    };
    const parsed = await this.post(body);
    if (parsed.value === null || typeof parsed.value !== 'object') {
      this.lastFailure = parsed.value === null ? parsed.failure : 'invalid_response';
      return null;
    }
    const obj = parsed.value as Record<string, unknown>;
    if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
      this.lastFailure = 'invalid_response';
      return null;
    }
    this.lastFailure = null;
    const type = isValidType(obj.type) ? obj.type : request.type;
    return {
      type,
      prompt: obj.prompt,
      expected: typeof obj.expected === 'string' ? obj.expected : null,
      model: this.env.model,
    };
  }

  /** One-time read-only liveness check with no user data. */
  async probe(): Promise<EndpointProbe> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.fetchWithTimeout(`${this.env.endpoint}/models`, { method: 'GET' }, PROBE_TIMEOUT_MS);
      if (response.ok) return { status: 'ready', error: null, checkedAt };
      // The status alone is actionable; the body is never recorded because
      // `refluent settings` prints this error.
      return { status: 'unreachable', error: `HTTP ${response.status}`, checkedAt };
    } catch (error) {
      return { status: 'unreachable', error: describeError(error), checkedAt };
    }
  }

  private async post(
    body: unknown,
  ): Promise<{ value: unknown; failure: null } | { value: null; failure: AnalysisFailure }> {
    try {
      const response = await this.fetchWithTimeout(`${this.env.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, ANALYSIS_TIMEOUT_MS);
      if (!response.ok) return { value: null, failure: httpFailure(response.status) };
      const json = (await response.json()) as { choices?: ChatChoice[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        return { value: null, failure: 'empty_response' };
      }
      try {
        return { value: JSON.parse(content) as unknown, failure: null };
      } catch {
        return { value: null, failure: 'invalid_response' };
      }
    } catch (error) {
      return { value: null, failure: transportFailure(error) };
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.env.apiKey) headers.authorization = `Bearer ${this.env.apiKey}`;
    try {
      return await fetch(url, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function isValidType(value: unknown): value is ReviewQuestionType {
  return value === 'zh-to-en' || value === 'rewrite-original' || value === 'fill-in';
}

/** Statuses a user can act on; anything else keeps its code so 404-vs-500 is visible. */
function httpFailure(status: number): AnalysisFailure {
  if (status === 401 || status === 403) return 'auth_rejected';
  if (status === 429) return 'rate_limited';
  return `http_error_${status}`;
}

function transportFailure(error: unknown): AnalysisFailure {
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  return 'network_error';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'timeout' : error.message;
  }
  return String(error);
}