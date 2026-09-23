import { describe, expect, it } from 'vitest';
import { filterNaturalLanguage } from '../src/filter.js';

describe('filter v2: unfenced code never reaches the model', () => {
  it('redacts identifiers and paths inside prose (R12)', () => {
    const result = filterNaturalLanguage('Can you fix the bug in src/db.ts? I think parseArgs() returns undefined.');
    expect(result.filteredText).toBe('Can you fix the bug in [code]? I think [code] returns undefined.');
    expect(result.redactions).toContain('R12-code-token');
  });

  it('drops unfenced code lines and keeps the prose around them (R13)', () => {
    const result = filterNaturalLanguage('Look at the code below and tell me why it fails:\nfunction add(a, b) { return a + b }');
    expect(result.filteredText).toBe('Look at the code below and tell me why it fails:');
    expect(result.redactions).toContain('R13-code-line');
  });

  it('drops bare shell commands without metacharacters (R8)', () => {
    const result = filterNaturalLanguage('I ran this and nothing happened at all.\ngit push origin main');
    expect(result.filteredText).toBe('I ran this and nothing happened at all.');
    expect(result.redactions).toContain('R8-shell-command');
  });

  it('never forwards a secret-looking token', () => {
    const result = filterNaturalLanguage('I think the token = sk-live-abc123 is leaking somewhere');
    expect(result.filteredText).not.toContain('sk-live');
  });

  it('keeps a slashed English word line instead of treating it as a path', () => {
    const result = filterNaturalLanguage('Ask whoever owns it, he/she will know the answer.');
    expect(result.filteredText).toBe('Ask whoever owns it, he/she will know the answer.');
  });
});
