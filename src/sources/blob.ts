import { makeSource, normalizePath, type Source, type SourceFile } from './source';

/**
 * A `SourceFile` over a `Blob`/`File`. In browsers a dropped `File` is a handle to data on disk, and in
 * Node `fs.openAsBlob()` returns the same kind of handle, so neither is read until a byte is needed.
 */
export function fileFromBlob(path: string, blob: Blob): SourceFile {
  return {
    path: normalizePath(path),
    size: blob.size,
    bytes: async () => new Uint8Array(await blob.arrayBuffer()),
    head: async (n) => new Uint8Array(await blob.slice(0, n).arrayBuffer()),
    stream: () => blob.stream() as ReadableStream<Uint8Array>,
  };
}

export interface BlobEntry {
  /** Path relative to what the user dropped, e.g. `ChatExport_2026-11-07/photos/photo_1@….jpg`. */
  path: string;
  blob: Blob;
}

export function sourceFromBlobs(name: string, entries: readonly BlobEntry[]): Source {
  return makeSource(name, entries.map((e) => fileFromBlob(e.path, e.blob)));
}
