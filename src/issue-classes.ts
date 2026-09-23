/**
 * The four issue classes, their value ranking and the analyst result contract.
 *
 * An analyzed message yields at most one suggestion, so the classifier keeps
 * the single highest-priority issue. Telegraphic agent-command style is
 * tolerated ellipsis, not an error.
 */

export type IssueClass =
  | 'chinese_code_mixing'
  | 'grammar_error'
  | 'chinglish_collocation'
  | 'register_tone';

export type IssueSeverity = 'high' | 'medium' | 'low';

export interface KnowledgePointKindMap {
  'expression-unit': true;
  'grammar-rule': true;
}
export type KnowledgePointKind = keyof KnowledgePointKindMap;

export interface AnalysisIssue {
  class: IssueClass;
  severity: IssueSeverity;
  span: string;
  explanation: string;
}

export interface KnowledgePointSpec {
  kind: KnowledgePointKind;
  canonical_form: string;
  explanation: string;
  rule_key: string | null;
}

export interface AnalysisResult {
  issue: AnalysisIssue | null;
  rewrite: string;
  reason: string;
  knowledge_point: KnowledgePointSpec | null;
  recurrence_of_kp_id: number | null;
  model?: string | null;
  model_version?: string | null;
}

export interface IssueClassInfo {
  id: IssueClass;
  label_zh: string;
  priority: number;
}

/** Higher priority (lower number) wins when a model returns more than one issue. */
export const ISSUE_CLASSES: readonly IssueClassInfo[] = [
  { id: 'chinese_code_mixing', label_zh: '中式夹英', priority: 1 },
  { id: 'grammar_error', label_zh: '语法错误', priority: 2 },
  { id: 'chinglish_collocation', label_zh: 'Chinglish 搭配', priority: 3 },
  { id: 'register_tone', label_zh: '语域语气', priority: 4 },
];

const BY_ID = new Map(ISSUE_CLASSES.map((c) => [c.id, c]));

export function isIssueClass(value: unknown): value is IssueClass {
  return typeof value === 'string' && BY_ID.has(value as IssueClass);
}

export function issueClassPriority(id: IssueClass): number {
  return BY_ID.get(id)?.priority ?? Number.MAX_SAFE_INTEGER;
}

export function issueClassLabel(id: IssueClass): string {
  return BY_ID.get(id)?.label_zh ?? id;
}

export function pickHighestIssue(issues: readonly AnalysisIssue[]): AnalysisIssue | null {
  if (issues.length === 0) return null;
  return [...issues].sort((a, b) => issueClassPriority(a.class) - issueClassPriority(b.class))[0] ?? null;
}

const GRAMMAR_RULES: ReadonlySet<string> = new Set([
  'tense', 'sentence-pattern', 'article', 'preposition', 'singular-plural',
]);

/**
 * Validates the single-JSON-object contract the analysis model must return.
 * Returns a normalized result, or null when any invariant is broken. A broken
 * result is treated exactly like an unavailable model: nothing is written.
 */
export function validateAnalysisResult(raw: unknown): AnalysisResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const issues = Array.isArray(obj.issue)
    ? (obj.issue as AnalysisIssue[])
    : obj.issue === null || obj.issue === undefined
      ? []
      : [obj.issue as AnalysisIssue];

  let issue: AnalysisIssue | null = null;
  if (issues.length > 0) {
    const candidate = pickHighestIssue(
      issues.filter(
        (i) =>
          typeof i === 'object' &&
          i !== null &&
          isIssueClass((i as AnalysisIssue).class),
      ),
    );
    if (candidate) {
      issue = {
        class: candidate.class,
        severity: normalizeSeverity(candidate.severity),
        span: typeof candidate.span === 'string' ? candidate.span : '',
        explanation: typeof candidate.explanation === 'string' ? candidate.explanation : '',
      };
    }
  }

  const rewrite = typeof obj.rewrite === 'string' ? obj.rewrite : null;
  const reason = typeof obj.reason === 'string' ? obj.reason : null;
  const kpRaw = typeof obj.knowledge_point === 'object' && obj.knowledge_point !== null
    ? (obj.knowledge_point as Record<string, unknown>)
    : null;

  if (issue === null) {
    return {
      issue: null,
      rewrite: rewrite ?? '',
      reason: reason ?? '',
      knowledge_point: null,
      recurrence_of_kp_id: null,
      model: readModelField(obj.model),
      model_version: readModelField(obj.model_version),
    };
  }

  if (!rewrite || !reason || !kpRaw) return null;

  const kind = kpRaw.kind;
  if (kind !== 'expression-unit' && kind !== 'grammar-rule') return null;
  const canonical = kpRaw.canonical_form;
  if (typeof canonical !== 'string' || canonical.trim().length === 0) return null;
  const ruleKey = typeof kpRaw.rule_key === 'string' && GRAMMAR_RULES.has(kpRaw.rule_key)
    ? kpRaw.rule_key
    : null;

  const recurrence = obj.recurrence_of_kp_id;
  return {
    issue,
    rewrite,
    reason,
    knowledge_point: {
      kind,
      canonical_form: canonical,
      explanation: typeof kpRaw.explanation === 'string' ? kpRaw.explanation : '',
      rule_key: ruleKey,
    },
    recurrence_of_kp_id:
      typeof recurrence === 'number' && Number.isInteger(recurrence) ? recurrence : null,
    model: readModelField(obj.model),
    model_version: readModelField(obj.model_version),
  };
}

function normalizeSeverity(value: unknown): IssueSeverity {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function readModelField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The static system prompt. It carries no user data. */
export const ANALYSIS_SYSTEM_PROMPT = [
  'You are a concise English-writing coach for a developer who works with a coding agent.',
  'You receive one piece of natural-language text that a developer wrote to the agent.',
  'Return a single JSON object and nothing else with these fields:',
  'issue: null, or an object {class, severity, span, explanation} where class is one of',
  '"chinese_code_mixing", "grammar_error", "chinglish_collocation", "register_tone",',
  'severity is "high"|"medium"|"low", span is the exact substring to improve, explanation is one short sentence.',
  'rewrite: the more natural full sentence (equals the original when issue is null).',
  'reason: one short sentence naming why, shown in a terminal status line.',
  'knowledge_point: null, or {kind, canonical_form, explanation, rule_key} where kind is',
  '"expression-unit" or "grammar-rule", canonical_form is the corrected reusable unit',
  '(a word, phrase or rule, never the whole sentence), rule_key is one of',
  '"tense","sentence-pattern","article","preposition","singular-plural" for grammar rules.',
  'recurrence_of_kp_id: integer or null.',
  'Rules: at most one issue; issue=null implies knowledge_point=null;',
  'issue!=null implies rewrite, reason and knowledge_point are present;',
  'telegraphic agent-command style is acceptable ellipsis, not an error, so never',
  'manufacture a grammar, collocation or register issue from it (chinese_code_mixing may still be flagged);',
  'never mention code, logs or error output because you will not receive them.',
].join(' ');

export const QUESTION_SYSTEM_PROMPT = [
  'You generate one short English practice question for a developer.',
  'You receive a knowledge point as canonical_form plus explanation and a question type.',
  'Return a single JSON object and nothing else with fields:',
  'prompt: the question text shown to the learner;',
  'expected: the target English expression (the canonical form), or null.',
  'For type "zh-to-en", write the prompt as a Chinese rendering of the meaning so the learner produces the English.',
  'For type "rewrite-original", write a fresh short sentence that contains the same mistake so the learner transfers the rule.',
  'For type "fill-in", blank the target span with ____.',
  'Do not include any code, logs or error output.',
].join(' ');