import { describe, expect, it } from 'vitest';
import {
  FILTER_VERSION,
  MAX_FILTERED_LENGTH,
  filterNaturalLanguage,
} from '../src/filter.js';

/**
 * Phase A removal rules (R1-R9): code, logs, stack traces, diffs and error
 * output must not survive into the model-bound text.
 */
describe('filter: removal rules', () => {
  it('R1 removes fenced code regions including the info string', () => {
    const result = filterNaturalLanguage(
      ['Please fix the login flow.', '```ts', 'const token = readToken();', '```', 'It keeps failing.'].join('\n'),
    );
    expect(result.filteredText).toBe('Please fix the login flow. It keeps failing.');
    expect(result.filteredText).not.toContain('readToken');
    expect(result.redactions).toContain('R1-fenced-code');
  });

  it('R1 handles tilde fences', () => {
    const result = filterNaturalLanguage('Here is the snippet.\n~~~\nrm -rf /\n~~~\nTell me what you think.');
    expect(result.filteredText).toBe('Here is the snippet. Tell me what you think.');
  });

  it('R2 removes indented code blocks', () => {
    const result = filterNaturalLanguage(
      ['Here is the plan for the parser.', '    const x = 1', '    const y = 2', 'Let me know what you think.'].join('\n'),
    );
    expect(result.filteredText).toBe('Here is the plan for the parser. Let me know what you think.');
    expect(result.redactions).toContain('R2-indented-code');
  });

  it('R3 removes inline code spans', () => {
    const result = filterNaturalLanguage('I call `foo()` in the loop and it breaks every single time.');
    expect(result.filteredText).toBe('I call in the loop and it breaks every single time.');
    expect(result.redactions).toContain('R3-inline-code');
  });

  it('R4 removes a Python stack trace header and its frames', () => {
    const result = filterNaturalLanguage(
      [
        'The parser crashes on large inputs.',
        'Traceback (most recent call last):',
        '  File "parse.py", line 42, in parse',
        '    return tokenize(text)',
        'Can you take a look at it?',
      ].join('\n'),
    );
    expect(result.filteredText).toBe('The parser crashes on large inputs. Can you take a look at it?');
    expect(result.redactions).toContain('R4-stack-trace');
  });

  it('R4 removes a JS stack trace with "at" frames', () => {
    const result = filterNaturalLanguage(
      [
        'The build fails on the new module.',
        'TypeError: cannot read property x',
        '    at parse (/app/src/parse.js:42:7)',
        '    at main (/app/src/index.js:9:3)',
        'Can you take a look at it?',
      ].join('\n'),
    );
    expect(result.filteredText).not.toContain('at parse');
    expect(result.redactions).toContain('R4-stack-trace');
  });

  it('R5 removes bracketed level tags, timestamps and JSON log objects', () => {
    const bracketed = filterNaturalLanguage(
      'Please review the worker output.\n[ERROR] failed to connect to the database\nTell me what you think.',
    );
    expect(bracketed.filteredText).toBe('Please review the worker output. Tell me what you think.');
    expect(bracketed.redactions).toContain('R5-log-line');

    const timestamped = filterNaturalLanguage(
      'Please review the worker output.\n2024-01-05T10:00:00Z starting worker\nTell me what you think.',
    );
    expect(timestamped.redactions).toContain('R5-log-line');

    const json = filterNaturalLanguage(
      'Please review the worker output.\n{"level":"info","msg":"ready"}\nTell me what you think.',
    );
    expect(json.redactions).toContain('R5-log-line');
  });

  it('R6 removes error lines', () => {
    const err = filterNaturalLanguage('The deploy failed again.\nError: connect ECONNREFUSED\nWhat should I do?');
    expect(err.filteredText).toBe('The deploy failed again. What should I do?');
    expect(err.redactions).toContain('R6-error-line');

    const shellErr = filterNaturalLanguage('The tool is missing.\nzsh: command not found: rg\nHow do I install it?');
    expect(shellErr.redactions).toContain('R6-error-line');
  });

  it('R7 removes diff, hunk, branch and porcelain status lines', () => {
    const result = filterNaturalLanguage(
      [
        'Here is what I changed today.',
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1234abc..5678def 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,3 @@',
        ' M src/a.ts',
        '?? src/b.ts',
        'On branch main',
        'Does this look right to you?',
      ].join('\n'),
    );
    expect(result.filteredText).toBe('Here is what I changed today. Does this look right to you?');
    expect(result.redactions).toContain('R7-diff-status');
  });

  it('R8 removes shell prompt lines and piped command lines', () => {
    const prompt = filterNaturalLanguage(
      'I cannot reproduce the failure locally.\n$ npm run build\nWhat should I do next?',
    );
    expect(prompt.filteredText).toBe('I cannot reproduce the failure locally. What should I do next?');
    expect(prompt.redactions).toContain('R8-shell-command');

    const piped = filterNaturalLanguage('The log is large.\nnpm run build | tee build.log\nHow do I trim it?');
    expect(piped.redactions).toContain('R8-shell-command');
  });

  it('R9 removes locator-only lines (paths and URLs)', () => {
    const path = filterNaturalLanguage(
      'I cannot find the module you mentioned.\nsrc/components/Button.tsx\nWhat should I do next?',
    );
    expect(path.filteredText).toBe('I cannot find the module you mentioned. What should I do next?');
    expect(path.redactions).toContain('R9-locator-only');

    const url = filterNaturalLanguage('The doc is somewhere.\nhttps://example.com/docs\nCan you point me at it?');
    expect(url.redactions).toContain('R9-locator-only');
  });

  it('R10 normalizes whitespace and R11 caps long messages without skipping them', () => {
    const long = `${'word '.repeat(400)}end`;
    const result = filterNaturalLanguage(long);
    expect(result.skipReason).toBeNull();
    expect(result.filteredText).not.toBeNull();
    expect(result.filteredText!.length).toBeLessThanOrEqual(MAX_FILTERED_LENGTH);
    expect(result.redactions).toContain('R11-length-cap');
  });
});

/** Phase B gates (G1-G4) and their named skip reasons. */
describe('filter: skip reasons', () => {
  it('G0 agent_generated for messages the agent harness injected, not the user', () => {
    const notification = [
      '<task-notification>',
      '<task-id>ae9b93ca9c68f370c</task-id>',
      '<status>completed</status>',
      '<summary>Agent "Find public HTTP RPC endpoint" finished</summary>',
      '<result>## 调查结果(只读,未做任何修改)',
      '### 1. 未认证 PUBLIC 路由走的 HTTP 路径',
      'The handler only accepts POST and forwards the request to the core service.',
      '</result>',
      '</task-notification>',
    ].join('\n');
    for (const raw of [
      notification,
      '  \n<task-notification>\n<status>completed</status>\n</task-notification>',
      '<system-reminder>The user sent a new message while you were working.</system-reminder>',
      '<local-command-stdout>Compacted the conversation history for you</local-command-stdout>',
      '<command-name>/review</command-name>\n<command-message>review the current branch please</command-message>',
      '<bash-stdout>everything is up to date with the remote branch</bash-stdout>',
    ]) {
      const result = filterNaturalLanguage(raw);
      expect(result.filteredText).toBeNull();
      expect(result.skipReason).toBe('agent_generated');
    }
  });

  it('G0 still analyzes a user message that merely mentions such a tag', () => {
    const result = filterNaturalLanguage('Why does the <task-notification> block show up in my suggestions?');
    expect(result.skipReason).toBeNull();
    expect(result.filteredText).not.toBeNull();
  });

  it('G1 empty_after_filter when only code survives removal', () => {
    const result = filterNaturalLanguage('```ts\nconst x = 1;\n```');
    expect(result.filteredText).toBeNull();
    expect(result.skipReason).toBe('empty_after_filter');
  });

  it('G2 too_short for fewer than four words', () => {
    expect(filterNaturalLanguage('run tests').skipReason).toBe('too_short');
    expect(filterNaturalLanguage('fix this quickly').skipReason).toBe('too_short');
  });

  it('G3 telegraphic_command for bare imperative agent commands', () => {
    const result = filterNaturalLanguage('fix the failing test in this module');
    expect(result.filteredText).toBeNull();
    expect(result.skipReason).toBe('telegraphic_command');
  });

  it('G3 tolerates a leading "please"', () => {
    expect(filterNaturalLanguage('please update the changelog entry for the release').skipReason).toBe(
      'telegraphic_command',
    );
  });

  it('G3 does not fire when the message asks a question', () => {
    expect(filterNaturalLanguage('fix the failing test in this module?').skipReason).toBeNull();
  });

  it('G4 low_natural_language for mostly numbers/punctuation', () => {
    expect(filterNaturalLanguage('1234 5678 9012 3456').skipReason).toBe('low_natural_language');
  });

  it('G5 admits Chinese content so it can be translated into English', () => {
    const pure = filterNaturalLanguage('帮我看看这个登录失败的问题');
    expect(pure.skipReason).toBeNull();
    expect(pure.filteredText).toBe('帮我看看这个登录失败的问题');

    // Mostly Chinese with one borrowed English word is translation material too.
    const borrowed = filterNaturalLanguage('我觉得这个 function 有问题，帮我看看');
    expect(borrowed.skipReason).toBeNull();
    expect(borrowed.filteredText).toBe('我觉得这个 function 有问题，帮我看看');
  });

  it('G5 no_coachable_text when there is neither English prose nor Chinese content', () => {
    expect(filterNaturalLanguage('ok').skipReason).toBe('too_short');
    // A long message in a third script is not English practice and not Chinese material.
    expect(filterNaturalLanguage('привет как дела у тебя сегодня').skipReason).toBe('no_coachable_text');
  });

  it('returns a normalized filtered text for ordinary prose', () => {
    const result = filterNaturalLanguage('  I   think   we should   split this file.  ');
    expect(result.skipReason).toBeNull();
    expect(result.filteredText).toBe('I think we should split this file.');
    expect(result.redactions).toEqual([]);
  });

  it('exposes a stable filter version', () => {
    expect(FILTER_VERSION).toBe('filter-v4');
  });
});