import { fileFromBytes } from './memory';
import { makeSource, type Source } from './source';
import { looksLikeZip, sourceFromZip } from './zip';

export * from './source';
export * from './memory';
export * from './blob';
export * from './zip';

/** Typed-array view backed by a plain `ArrayBuffer` (what `Blob`/`BufferSource` parameters accept). */
export function arrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/** A single in-memory file: a zip is opened as an archive, anything else is a one-file source. */
export async function sourceFromInputFile(file: { name: string; bytes: Uint8Array }): Promise<Source> {
  if (looksLikeZip(file.bytes.subarray(0, 4))) {
    return sourceFromZip(file.name, new Blob([arrayBufferView(file.bytes)]));
  }
  return makeSource(file.name.replace(/\.[^./]+$/, ''), [fileFromBytes(file.name, file.bytes)]);
}
