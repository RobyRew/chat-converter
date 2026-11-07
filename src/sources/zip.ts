import { BlobReader, Uint8ArrayWriter, ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js';
import { makeSource, normalizePath, type Source, type SourceFile } from './source';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Entry names without the UTF-8 (EFS) flag are CP437 by the spec, but WhatsApp writes UTF-8 names
 * without setting the flag (its contact cards carry U+200E in the name). Bytes that decode as valid
 * UTF-8 are therefore read as UTF-8; anything else falls back to zip.js's CP437 decoding.
 */
function decodeText(value: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(value);
  } catch {
    return undefined;
  }
}

function isFileEntry(entry: Entry): entry is FileEntry {
  return !entry.directory;
}

function fileFromEntry(entry: FileEntry): SourceFile {
  const read = async (): Promise<Uint8Array> => entry.getData(new Uint8ArrayWriter());
  return {
    path: normalizePath(entry.filename),
    size: entry.uncompressedSize,
    bytes: read,
    // Compressed entries can't be read partially; heads are only taken from chat files, which are small.
    head: async (n) => (await read()).subarray(0, n),
    stream: () => {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      entry.getData(writable).catch((error: unknown) => {
        void writable.abort(error).catch(() => undefined);
      });
      return readable;
    },
  };
}

/** Opens a zip lazily: only the central directory is read up front; entries are inflated on demand. */
export async function sourceFromZip(name: string, blob: Blob): Promise<Source> {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false, decodeText });
  const entries = await reader.getEntries();
  const files = entries.filter(isFileEntry).map(fileFromEntry);
  return makeSource(name.replace(/\.zip$/i, ''), files);
}

/** `PK\x03\x04` (local file header) or `PK\x05\x06` (empty archive). */
export function looksLikeZip(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06))
  );
}
