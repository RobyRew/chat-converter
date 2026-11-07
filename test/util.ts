import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InputFile } from '../src/engine/contracts';

export function load(name: string): InputFile {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return { name, bytes: new Uint8Array(readFileSync(p)) };
}

export function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
