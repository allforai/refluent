import type {
  AnalysisClient,
  AnalyzeRequest,
  GenerateQuestionRequest,
  ReviewQuestionSpec,
} from './types.js';
import type { AnalysisResult } from '../issue-classes.js';

export interface StubCalls {
  analyze: AnalyzeRequest[];
  generateQuestion: GenerateQuestionRequest[];
}

export type AnalyzeResponder = (filteredText: string) => AnalysisResult | null;
export type QuestionResponder = (request: GenerateQuestionRequest) => ReviewQuestionSpec | null;

/**
 * Deterministic in-process stub used by the vitest suite. It records every
 * request so tests can assert that only filtered text ever reaches a client.
 */
export class StubAnalysisClient implements AnalysisClient {
  readonly calls: StubCalls = { analyze: [], generateQuestion: [] };

  constructor(
    private readonly analyzeResponder: AnalyzeResponder,
    private readonly questionResponder?: QuestionResponder,
  ) {}

  async analyze(request: AnalyzeRequest): Promise<AnalysisResult | null> {
    this.calls.analyze.push(request);
    return this.analyzeResponder(request.filteredText);
  }

  async generateQuestion(request: GenerateQuestionRequest): Promise<ReviewQuestionSpec | null> {
    this.calls.generateQuestion.push(request);
    if (this.questionResponder) return this.questionResponder(request);
    return null;
  }
}

/** A stub that reports no issue for any text. */
export function silentStub(): StubAnalysisClient {
  return new StubAnalysisClient(() => null);
}

/** Used when the analysis endpoint is not configured; every call degrades to null. */
export class NullAnalysisClient implements AnalysisClient {
  async analyze(): Promise<AnalysisResult | null> {
    return null;
  }

  async generateQuestion(): Promise<ReviewQuestionSpec | null> {
    return null;
  }
}