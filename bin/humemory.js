#!/usr/bin/env bun
/**
 * Point d'entrée de la CLI.
 *
 * humemory tourne sous bun, pas sous node : le store utilise `bun:sqlite`, que
 * le loader ESM de node ne sait pas résoudre. Le shebang vise donc bun, et le
 * garde ci-dessous rattrape l'appel explicite `node bin/humemory.js` avec un
 * message lisible plutôt qu'un ERR_UNSUPPORTED_ESM_URL_SCHEME.
 */

if (typeof Bun === 'undefined') {
  console.error(
    'humemory a besoin de bun (le store utilise bun:sqlite).\n' +
      'Installe-le : https://bun.sh — puis relance `humemory` ou `bun bin/humemory.js`.'
  );
  process.exit(1);
}

await import('../dist/cli/index.js');
