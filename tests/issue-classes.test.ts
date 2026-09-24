import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SYSTEM_PROMPT,
  ISSUE_CLASSES,
  issueClassLabel,
  issueClassPriority,
  isIssueClass,
  pickHighestIssue,
  validateAnalysisResult,
  type AnalysisIssue,
} from '../src/issue-classes.js';

describe('issue classes: the five classes and their ranking', () => {
  it('defines exactly the five designed classes in value order', () => {
    expect(ISSUE_CLASSES.map((c) => c.id)).toEqual([
      'chinese_code_mixing',
      'grammar_error',
      'chinglish_collocation',
      'register_tone',
      'chinese_translation',
    ]);
    expect(ISSUE_CLASSES.map((c) => c.priority)).toEqual([1, 2, 3, 4, 5]);
    expect(ISSUE_CLASSES.map((c) => c.label_zh)).toEqual([
      '中式夹英',
      '语法错误',
      'Chinglish 搭配',
      '语域语气',
      '中文→英文',
    ]);
  });

  it('ranks code mixing above grammar above collocation above register above translation', () => {
    expect(issueClassPriority('chinese_code_mixing')).toBeLessThan(issueClassPriority('grammar_error'));
    expect(issueClassPriority('grammar_error')).toBeLessThan(issueClassPriority('chinglish_collocation'));
    expect(issueClassPriority('chinglish_collocation')).toBeLessThan(issueClassPriority('register_tone'));
    expect(issueClassPriority('register_tone')).toBeLessThan(issueClassPriority('chinese_translation'));
  });

  it('translates a Chinese sentence only when no English-coaching issue applies', () => {
    const both: AnalysisIssue[] = [
      { class: 'chinese_translation', severity: 'medium', span: '帮我看看', explanation: 'translation' },
      { class: 'grammar_error', severity: 'high', span: 'go', explanation: 'tense' },
    ];
    expect(pickHighestIssue(both)?.class).toBe('grammar_error');
    expect(pickHighestIssue([both[0]!])?.class).toBe('chinese_translation');
  });

  it('picks the single highest-value issue, never more than one', () => {
    const issues: AnalysisIssue[] = [
      { class: 'register_tone', severity: 'low', span: 'kindly', explanation: 'too formal' },
      { class: 'chinese_code_mixing', severity: 'high', span: '这个', explanation: 'mixed language' },
      { class: 'grammar_error', severity: 'medium', span: 'finish', explanation: 'tense' },
    ];
    expect(pickHighestIssue(issues)?.class).toBe('chinese_code_mixing');
    expect(pickHighestIssue([])).toBeNull();
  });

  it('exposes the zh labels used in the status line', () => {
    expect(issueClassLabel('grammar_error')).toBe('语法错误');
    expect(issueClassLabel('register_tone')).toBe('语域语气');
    expect(issueClassLabel('chinese_translation')).toBe('中文→英文');
  });

  it('recognises only the five class ids', () => {
    expect(isIssueClass('grammar_error')).toBe(true);
    expect(isIssueClass('chinese_translation')).toBe(true);
    expect(isIssueClass('spelling')).toBe(false);
  });
});

describe('issue classes: model result contract', () => {
  it('accepts a well-formed issue with a knowledge point', () => {
    const result = validateAnalysisResult({
      issue: { class: 'grammar_error', severity: 'high', span: 'finish', explanation: 'wrong tense' },
      rewrite: 'I already finished the refactor yesterday.',
      reason: 'past tense needed',
      knowledge_point: {
        kind: 'grammar-rule',
        canonical_form: 'already finished',
        explanation: 'past simple',
        rule_key: 'tense',
      },
      recurrence_of_kp_id: 7,
    });
    expect(result).not.toBeNull();
    expect(result!.issue!.class).toBe('grammar_error');
    expect(result!.knowledge_point!.rule_key).toBe('tense');
    expect(result!.recurrence_of_kp_id).toBe(7);
  });

  it('accepts a Chinese translation suggestion with an expression-unit point', () => {
    const result = validateAnalysisResult({
      issue: {
        class: 'chinese_translation',
        severity: 'medium',
        span: '帮我看看这个登录失败的问题',
        explanation: 'translate into English',
      },
      rewrite: 'Can you help me look into why the login keeps failing?',
      reason: 'Translated from Chinese.',
      knowledge_point: {
        kind: 'expression-unit',
        canonical_form: 'look into why',
        explanation: 'investigate the cause',
        rule_key: null,
      },
      recurrence_of_kp_id: null,
    });
    expect(result).not.toBeNull();
    expect(result!.issue!.class).toBe('chinese_translation');
    expect(result!.knowledge_point!.kind).toBe('expression-unit');
  });

  it('issue=null implies no knowledge point and no suggestion payload', () => {
    const result = validateAnalysisResult({
      issue: null,
      rewrite: 'Looks good to me.',
      reason: 'nothing to improve',
      knowledge_point: {
        kind: 'expression-unit',
        canonical_form: 'looks good',
        explanation: 'ignored',
        rule_key: null,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.issue).toBeNull();
    expect(result!.knowledge_point).toBeNull();
  });

  it('rejects an issue that is missing rewrite, reason or knowledge point', () => {
    expect(
      validateAnalysisResult({
        issue: { class: 'grammar_error', severity: 'high', span: 'x', explanation: 'y' },
        rewrite: 'ok',
        reason: 'ok',
        knowledge_point: null,
      }),
    ).toBeNull();
  });

  it('rejects an out-of-contract knowledge point kind', () => {
    expect(
      validateAnalysisResult({
        issue: { class: 'grammar_error', severity: 'high', span: 'x', explanation: 'y' },
        rewrite: 'ok',
        reason: 'ok',
        knowledge_point: { kind: 'vocabulary', canonical_form: 'foo', explanation: '', rule_key: null },
      }),
    ).toBeNull();
  });

  it('rejects a blank canonical form', () => {
    expect(
      validateAnalysisResult({
        issue: { class: 'grammar_error', severity: 'high', span: 'x', explanation: 'y' },
        rewrite: 'ok',
        reason: 'ok',
        knowledge_point: { kind: 'grammar-rule', canonical_form: '   ', explanation: '', rule_key: null },
      }),
    ).toBeNull();
  });
});

describe('issue classes: telegraphic tolerance', () => {
  it('instructs the classifier that telegraphic agent style is not an error', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('telegraphic agent-command style is acceptable ellipsis');
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('never manufacture a grammar, collocation or register issue');
  });

  it('keeps the system prompt static and free of user data', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).not.toMatch(/https?:\/\//);
  });
});