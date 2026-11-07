import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import type { OutputFile } from './contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function strToU8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function strFromU8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** ZIP local-file-header magic: 'PK\x03\x04'. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Zips small in-memory outputs. Large packages stream through `ZipSink` instead. */
export async function zipFiles(files: readonly OutputFile[]): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: true });
  for (const f of files) {
    await writer.add(f.name, new Uint8ArrayReader(f.bytes), { useUnicodeFileNames: true });
  }
  return writer.close();
}
