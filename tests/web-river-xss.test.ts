import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Regression for SECURITY_AUDIT.md H-02: the river tooltip used to build its
 * markup with `innerHTML` from raw memory content, letting a stored memory run
 * script in the dashboard's origin. It now builds the tooltip DOM node by node.
 */

const realFetch = globalThis.fetch;

const XSS_PAYLOAD = '<img src=x onerror="window.__xssFired = true">';

function stubFetch(memories: unknown[]) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes('/memories')) {
      return new Response(JSON.stringify({ success: true, memories }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  (window as any).__xssFired = undefined;
  document.body.innerHTML = '';
});

describe('river tooltip (H-02 XSS)', () => {
  test('stored memory content never executes as markup', async () => {
    stubFetch([
      {
        id: 'm1',
        content: XSS_PAYLOAD,
        directory: '/x',
        memoryType: 'decision',
        createdAt: '2026-01-01T00:00:00.000Z',
        recallCount: 0,
        keywords: [],
        saillance: 100,
        currentLevel: 0,
        photographic: false,
      },
    ]);

    const { createMount } = await import('../web/viz/river.ts');
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });

    const unmount = await createMount()(container);

    const pill = container.querySelector('.river-memory') as SVGGElement | null;
    expect(pill).not.toBeNull();

    pill!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    const tooltip = document.querySelector('.river-tooltip') as HTMLElement | null;
    expect(tooltip).not.toBeNull();

    // The payload must be inert text, never a parsed <img>.
    expect(tooltip!.querySelector('img')).toBeNull();
    expect(tooltip!.textContent).toContain(XSS_PAYLOAD);
    expect((window as any).__xssFired).toBeUndefined();

    unmount();
  });
});
