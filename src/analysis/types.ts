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
 * The model boundary. Tests inject a deterministic in-process stub so the
 * vitest suite makes no network call.
 */
export interface AnalysisClient {
  analyze(request: AnalyzeRequest): Promise<AnalysisResult | null>;
  generateQuestion(request: GenerateQuestionRequest): Promise<ReviewQuestionSpec | null>;
}

export type { AnalysisResult, KnowledgePointSpec, KnowledgePointKind };