// Astro's type check — what `astro check` runs: @astrojs/language-server's AstroCheck — on TypeScript 6.
//
// The site compiles with TypeScript 7, whose compiler ships without the JavaScript API Astro's checker drives
// (`require('typescript')` exposes little more than `version`). @astrojs/check 0.9.12 declares
// `typescript ^5 || ^6` as a peer, which npm refuses next to the site's typescript 7, and npm overrides do not
// change how a peer is satisfied. So the checker runs from its library with an explicit TypeScript: the
// `typescript-6` alias in package.json. When Astro's checker accepts TypeScript 7, `astro check` replaces this
// script (ADR-0011).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AstroCheck } from '@astrojs/language-server';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const checker = new AstroCheck(root, require.resolve('typescript-6'), undefined);
const result = await checker.lint({ logErrors: { level: 'hint' } });
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
console.info(
  `Result (${count(result.fileChecked, 'file')}, TypeScript ${checker.ts.version}): ` +
    `${count(result.errors, 'error')}, ${count(result.warnings, 'warning')}, ${count(result.hints, 'hint')}`,
);
process.exitCode = result.errors > 0 ? 1 : 0;
