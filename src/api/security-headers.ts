/**
 * Browser defence headers (SECURITY_AUDIT.md M-04).
 *
 * These do not replace escaping the data — H-02 is fixed at the sink — but they
 * cap the blast radius of any sink we missed and stop the dashboard being framed.
 *
 * Extracted from `server.ts` so the policy can be tested: importing `server.ts`
 * constructs the store and would open the production database (BUG-08).
 */

import { NONCE, secureHeaders } from 'hono/secure-headers';

// hono does not export its options type; derive it from the middleware itself so
// this object stays checked against the version actually installed.
type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

export const SECURE_HEADERS_OPTIONS: SecureHeadersOptions = {
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    // React/d3/three are bundled to /app/*.js; the only inline script is
    // session.html's, which carries the nonce.
    scriptSrc: [NONCE, "'self'"],
    // style-src covers <style> blocks and stylesheets. Element.style writes from
    // JS go through the CSSOM and are not affected by this directive; the
    // `style="…"` attributes in session.html are, hence styleSrcAttr.
    styleSrc: [NONCE, "'self'"],
    styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    workerSrc: ["'self'", 'blob:'],
  },
  // The dashboard is served over plain HTTP on loopback by default; forcing
  // HSTS there would poison the browser for every other localhost service.
  strictTransportSecurity: false,
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'no-referrer',
};

/**
 * Stamps the per-request CSP nonce onto the inline <script>/<style> tags of a
 * static HTML page, so they run without weakening the policy to 'unsafe-inline'.
 * A tag that already carries a nonce is left as it is.
 */
export function injectNonce(html: string, nonce: string): string {
  return html
    .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replace(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`);
}
