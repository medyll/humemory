import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { secureHeaders, NONCE } from 'hono/secure-headers';
import type { SecureHeadersVariables } from 'hono/secure-headers';
import { injectNonce, SECURE_HEADERS_OPTIONS } from '../src/api/security-headers.js';

/**
 * Regression for SECURITY_AUDIT.md M-04 (headers half): the dashboard shipped no
 * CSP, no frame-ancestors/X-Frame-Options, no nosniff and no referrer policy, so
 * any XSS sink we missed had free rein and the page could be framed.
 *
 * `server.ts` cannot be imported here — it constructs the store at module load
 * and would open the production database — so the middleware is mounted from the
 * same shared options object the server uses.
 */

function appWithHeaders() {
  const app = new Hono<{ Variables: SecureHeadersVariables }>();
  app.use('*', secureHeaders(SECURE_HEADERS_OPTIONS));
  app.get('/page', (c) =>
    c.html(injectNonce('<style>body{}</style><script>window.ran=1</script>', c.get('secureHeadersNonce') ?? ''))
  );
  return app;
}

async function headersFor(path = '/page') {
  const res = await appWithHeaders().request(`http://local${path}`);
  return { res, body: await res.text() };
}

describe('browser defence headers (M-04)', () => {
  test('sends a CSP that locks the page to its own origin', async () => {
    const { res } = await headersFor();
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  test('forbids framing, sniffing and referrer leakage', async () => {
    const { res } = await headersFor();
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('script-src uses a nonce and never "unsafe-inline"', async () => {
    const { res } = await headersFor();
    const csp = res.headers.get('content-security-policy') ?? '';

    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toMatch(/'nonce-[^']+'/);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  test('does not force HSTS — the dashboard is plain HTTP on loopback', async () => {
    // Setting HSTS here would poison the browser for every other localhost service.
    const { res } = await headersFor();
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  test('the nonce is fresh per request', async () => {
    const first = (await headersFor()).res.headers.get('content-security-policy') ?? '';
    const second = (await headersFor()).res.headers.get('content-security-policy') ?? '';
    const nonceOf = (csp: string) => csp.match(/'nonce-([^']+)'/)?.[1];

    expect(nonceOf(first)).toBeDefined();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });
});

describe('injectNonce', () => {
  test('stamps the served inline script and style with the header nonce', async () => {
    const { res, body } = await headersFor();
    const nonce = (res.headers.get('content-security-policy') ?? '').match(/'nonce-([^']+)'/)?.[1];

    expect(nonce).toBeDefined();
    expect(body).toContain(`<script nonce="${nonce}"`);
    expect(body).toContain(`<style nonce="${nonce}"`);
  });

  test('leaves a tag that already carries a nonce alone', () => {
    const html = '<script nonce="kept" src="/a.js"></script>';
    expect(injectNonce(html, 'new')).toBe(html);
  });

  test('does not touch non-script/style markup', () => {
    expect(injectNonce('<div>hi</div>', 'n')).toBe('<div>hi</div>');
  });
});
