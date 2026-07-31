/**
 * Enregistre un DOM global pour les tests de composants.
 *
 * Préchargé pour toute la suite via bunfig.toml. Les tests backend n'en font
 * rien : ils ignorent simplement `window` et `document`. On garde ainsi un seul
 * runner (`bun test`) et une seule commande, conformément à docs/TESTING.md.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (typeof (globalThis as any).document === 'undefined') {
  GlobalRegistrator.register();
}
