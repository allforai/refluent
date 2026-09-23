import { describe, expect, it } from 'vitest';
import { isBareShellCommand, isCodeToken, redactLine } from '../src/redact.js';

describe('redact: code-like tokens are replaced, prose survives', () => {
  it('replaces a path and a call inside an otherwise natural sentence', () => {
    expect(redactLine('Can you fix the bug in src/db.ts? I think parseArgs() returns undefined.').text).toBe(
      'Can you fix the bug in [code]? I think [code] returns undefined.',
    );
  });

  it('replaces secrets, operators, hashes and email addresses', () => {
    expect(redactLine('I think the token = sk-live-abc123 is leaking somewhere').text).toBe(
      'I think the token [code] [code] is leaking somewhere',
    );
    expect(redactLine('The commit abc1234f broke it').text).toBe('The commit [code] broke it');
    expect(redactLine('Please email me at a@b.com about it').text).toBe('Please email me at [code] about it');
  });

  it('drops lines shaped like code or dominated by code tokens', () => {
    expect(redactLine('function add(a, b) { return a + b }').dropLine).toBe(true);
    expect(redactLine('const token = readToken();').dropLine).toBe(true);
    expect(redactLine('npm run build --filter=@app/core --since origin/main').dropLine).toBe(true);
  });

  it('leaves ordinary prose, abbreviations and slashed words alone', () => {
    for (const line of [
      'I think we should split this file.',
      '(see above) we need e.g. a fix, i.e. soon.',
      'he/she and/or 24/7 are fine here',
      '这里 is mixed language.',
    ]) {
      expect(redactLine(line)).toEqual({ text: line, dropLine: false, redactedTokens: 0 });
    }
  });

  it('classifies single tokens', () => {
    for (const t of ['README.md', './scripts', 'process.env', 'hook_installed', '--yes', 'ghp_abcdefghijkl']) {
      expect(isCodeToken(t)).toBe(true);
    }
    for (const t of ['bug', 'e.g', 'he/she', 'module']) {
      expect(isCodeToken(t)).toBe(false);
    }
  });

  it('recognises bare shell commands without metacharacters', () => {
    expect(isBareShellCommand('git push origin main')).toBe(true);
    expect(isBareShellCommand('go test ./...')).toBe(true);
    expect(isBareShellCommand('go ahead and merge it')).toBe(false);
    expect(isBareShellCommand('make sure the tests pass')).toBe(false);
  });
});
