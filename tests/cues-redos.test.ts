import { describe, test, expect } from 'bun:test';
import {
  eventTriggerMatches,
  isDangerousPattern,
  MAX_PATTERN_LENGTH,
  MAX_MATCH_TEXT_LENGTH,
} from '../src/core/cues.js';
import { validateAppEvent, validateTriggerSpec } from '../src/api/intentions-routes.js';

/**
 * Regression for SECURITY_AUDIT.md M-01: `error_pattern` cues compiled an
 * unauthenticated string with the backtracking RegExp engine and ran it
 * synchronously, so `^(a+)+$` against a long non-matching text pinned the
 * event loop. Dangerous shapes now degrade to a literal search, and both the
 * pattern and the text are bounded.
 */

function evt(text: string) {
  return { type: 'error_pattern' as const, text, directory: '/x' };
}

function spec(pattern: string) {
  return { kind: 'event' as const, type: 'error_pattern' as const, pattern };
}

describe('isDangerousPattern', () => {
  test('flags quantified groups that contain a quantifier', () => {
    for (const p of ['^(a+)+$', '(a*)*', '(a+|b)*', '(\\d+)+x', '(ab+)*c']) {
      expect(isDangerousPattern(p)).toBe(true);
    }
  });

  test('accepts ordinary patterns', () => {
    for (const p of ['ECONNREFUSED', 'TypeError: .* undefined', '^\\s*at\\s', 'foo|bar', '(cat|dog)s']) {
      expect(isDangerousPattern(p)).toBe(false);
    }
  });

  test('does not mistake escaped parens or quantifiers for structure', () => {
    expect(isDangerousPattern('\\(a\\+\\)\\+')).toBe(false);
  });

  test('flags an oversized pattern regardless of shape', () => {
    expect(isDangerousPattern('a'.repeat(MAX_PATTERN_LENGTH + 1))).toBe(true);
  });
});

describe('error_pattern matching (M-01)', () => {
  test('catastrophic pattern returns promptly instead of hanging', () => {
    const evil = '^(a+)+$';
    const text = 'a'.repeat(5_000) + '!'; // classic non-matching tail

    const started = Date.now();
    const matched = eventTriggerMatches(spec(evil), evt(text));
    const elapsed = Date.now() - started;

    // Degraded to a literal search: the pattern text is not in the payload.
    expect(matched).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
  });

  test('a benign pattern still matches normally', () => {
    expect(eventTriggerMatches(spec('ECONNREFUSED'), evt('Error: ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
    expect(eventTriggerMatches(spec('^TypeError'), evt('TypeError: x is undefined'))).toBe(true);
    expect(eventTriggerMatches(spec('^TypeError'), evt('RangeError: nope'))).toBe(false);
  });

  test('matching is bounded even for a very long event text', () => {
    const long = 'x'.repeat(MAX_MATCH_TEXT_LENGTH * 2) + 'NEEDLE';
    // The needle sits past the cap, so it must not be seen.
    expect(eventTriggerMatches(spec('NEEDLE'), evt(long))).toBe(false);
  });
});

describe('API validation (M-01)', () => {
  test('rejects an event text beyond the cap', () => {
    expect(() => validateAppEvent(evt('x'.repeat(MAX_MATCH_TEXT_LENGTH + 1)))).toThrow(/at most/);
  });

  test('accepts an event text at the cap', () => {
    expect(() => validateAppEvent(evt('x'.repeat(MAX_MATCH_TEXT_LENGTH)))).not.toThrow();
  });

  test('refuses to arm a cue on a backtracking-prone pattern', () => {
    expect(() => validateTriggerSpec(spec('^(a+)+$'))).toThrow(/backtracking/);
  });

  test('refuses to arm a cue on an oversized pattern', () => {
    expect(() => validateTriggerSpec(spec('a'.repeat(MAX_PATTERN_LENGTH + 1)))).toThrow(/at most/);
  });

  test('still arms a cue on an ordinary pattern', () => {
    expect(validateTriggerSpec(spec('ECONNREFUSED'))).toEqual({
      kind: 'event',
      type: 'error_pattern',
      pattern: 'ECONNREFUSED',
    });
  });
});
