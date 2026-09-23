import { describe, expect, it } from 'vitest';
import { countWords, filterNaturalLanguage } from '../src/filter.js';

describe('filter v2: Chinese-English mixing', () => {
  it('counts each CJK ideograph and each embedded Latin word as a unit', () => {
    expect(countWords('帮我look一下this bug')).toBe(7);
    expect(countWords('run the tests')).toBe(3);
  });

  it('does not skip a spaceless mixed message as too_short', () => {
    const result = filterNaturalLanguage('帮我look一下this bug');
    expect(result.skipReason).toBeNull();
    expect(result.filteredText).toBe('帮我look一下this bug');
  });

  it('skips a Chinese message that only borrows one English term', () => {
    expect(filterNaturalLanguage('我觉得这个 function 有问题，帮我看看').skipReason).toBe('no_english');
  });

  it('keeps the numeric-only message as low_natural_language', () => {
    expect(filterNaturalLanguage('1234 5678 9012 3456').skipReason).toBe('low_natural_language');
  });
});
