import { makeSource, normalizePath, type Source, type SourceFile } from './source';

/** A `SourceFile` over bytes already in memory (tests, small uploads, the ChatForge API sandbox). */
export function fileFromBytes(path: string, data: Uint8Array): SourceFile {
  return {
    path: normalizePath(path),
    size: data.byteLength,
    bytes: async () => data,
    head: async (n) => data.subarray(0, n),
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
  };
}

export function sourceFromBytes(name: string, files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Source {
  return makeSource(name, files.map((f) => fileFromBytes(f.path, f.bytes)));
}
