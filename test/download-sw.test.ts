import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('download-sw.js', () => {
  it('stays above the default Vite assetsInlineLimit, so bundlers emit it as a file instead of a data: URL', () => {
    expect(statSync(new URL('../src/ui/download-sw.js', import.meta.url)).size).toBeGreaterThan(4096);
  });
});
