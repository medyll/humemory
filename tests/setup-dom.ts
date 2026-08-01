/**
 * Registers a global DOM for the component tests.
 *
 * Preloaded for the whole suite through bunfig.toml. Backend tests do nothing
 * with it: they simply ignore `window` and `document`. That keeps one runner
 * (`bun test`) and one command, as docs/TESTING.md requires.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (typeof (globalThis as any).document === 'undefined') {
  GlobalRegistrator.register();
}
