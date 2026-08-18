import { describe, test, expect } from 'bun:test';
import { makeOriginChecker } from '../src/api/cors.js';

/**
 * Regression for SECURITY_AUDIT.md M-04.
 *
 * The origin check was `origin.includes(allowed)`, a substring test: any origin
 * merely *containing* an allowed one was echoed back, and the no-Origin branch
 * answered `*` while `credentials: true` was set — a combination browsers reject.
 *
 * The browser defence headers (CSP with a per-request nonce, frame-ancestors,
 * nosniff, referrer policy) are asserted against the live server in
 * `tests/api-security-headers.test.ts`.
 */

const ALLOWED = ['http://localhost:3456', 'http://127.0.0.1:3456'];

describe('CORS origin allow-list (M-04)', () => {
  const check = makeOriginChecker(ALLOWED);

  test('echoes an exactly matching origin', () => {
    expect(check('http://localhost:3456')).toBe('http://localhost:3456');
    expect(check('http://127.0.0.1:3456')).toBe('http://127.0.0.1:3456');
  });

  test('refuses an origin that merely contains an allowed one', () => {
    // The exact bug: these all passed the old `.includes()` test.
    expect(check('http://localhost:3456.evil.example')).toBeUndefined();
    expect(check('https://evil.example/http://localhost:3456')).toBeUndefined();
    expect(check('http://evil-http://localhost:3456')).toBeUndefined();
  });

  test('refuses an origin that only shares a prefix or suffix', () => {
    expect(check('http://evil-localhost:3456')).toBeUndefined();
    expect(check('http://localhost:34567')).toBeUndefined();
  });

  test('distinguishes scheme and port', () => {
    expect(check('https://localhost:3456')).toBeUndefined();
    expect(check('http://localhost:3000')).toBeUndefined();
  });

  test('never answers "*" — that is invalid alongside credentials', () => {
    expect(check('')).toBeUndefined();
    expect(check('null')).toBeUndefined();
    expect(check('not a url')).toBeUndefined();
  });

  test('tolerates whitespace and trailing slashes in the configured list', () => {
    // CORS_ORIGINS is a comma-separated env string, so entries arrive untidy.
    const lenient = makeOriginChecker([' http://localhost:3456/ ', 'http://app.example']);
    expect(lenient('http://localhost:3456')).toBe('http://localhost:3456');
    expect(lenient('http://app.example')).toBe('http://app.example');
  });

  test('ignores unparseable entries in the configured list', () => {
    const messy = makeOriginChecker(['', 'nonsense', 'http://ok.example']);
    expect(messy('http://ok.example')).toBe('http://ok.example');
    expect(messy('nonsense')).toBeUndefined();
  });
});
