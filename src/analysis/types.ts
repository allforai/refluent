import type { AnalysisResult, KnowledgePointKind, KnowledgePointSpec } from '../issue-classes.js';

export type ReviewQuestionType = 'zh-to-en' | 'rewrite-original' | 'fill-in';

export interface AnalyzeRequest {
  /** Exactly the output of filterNaturalLanguage; the only user-derived request body. */
  filteredText: string;
  filterVersion: string;
}

export interface GenerateQuestionRequest {
  knowledgePoint: {
    id: number;
    kind: KnowledgePointKind;
    canonicalForm: string;
    explanation: string | null;
    ruleKey: string | null;
  };
  type: ReviewQuestionType;
  /** Already-filtered original sentence, used as light context. Never raw text. */
  contextSentence?: string | null;
}

export interface ReviewQuestionSpec {
  type: ReviewQuestionType;
  prompt: string;
  expected: string | null;
  model?: string | null;
}

/**
 * Sanitized cause of a failed model call. Callers that only need "it did not
 * work" keep treating a null result as failure; callers that must explain why
 * read `lastFailure` so the record stays actionable without echoing response
 * bodies or request payloads.
 */
export type AnalysisFailure =
  | 'not_configured'
  | 'auth_rejected'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'empty_response'
  | 'invalid_response'
  | `http_error_${number}`;

/**
 * The model boundary. Tests inject a deterministic in-process stub so the
 * vitest suite makes no network call.
 */
export interface AnalysisClient {
  analyze(request: AnalyzeRequest): Promise<AnalysisResult | null>;
  generateQuestion(request: GenerateQuestionRequest): Promise<ReviewQuestionSpec | null>;
  /** Sanitized reason for the most recent failed call, if any. Never a payload. */
  readonly lastFailure?: AnalysisFailure | null;
}

export type { AnalysisResult, KnowledgePointSpec, KnowledgePointKind };