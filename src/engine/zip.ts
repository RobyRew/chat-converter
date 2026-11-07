import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { InputFile, OutputFile } from './contracts';

/** ZIP local-file-header magic: 'PK\x03\x04'. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function unzip(bytes: Uint8Array): InputFile[] {
  const entries = unzipSync(bytes);
  return Object.entries(entries).map(([name, b]) => ({ name, bytes: b }));
}

export function zip(files: OutputFile[]): Uint8Array {
  const obj: Record<string, Uint8Array> = {};
  for (const f of files) obj[f.name] = f.bytes;
  return zipSync(obj);
}

export { strFromU8, strToU8 };
