import { Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { SourceFile } from '../sources/source';

export interface ZipProgress {
  /** Entries fully written so far. */
  entries: number;
  /** Bytes written to the destination so far (archive bytes, not source bytes). */
  bytes: number;
}

export interface ZipEntryOptions {
  /** Deflate level 0–9. Media is stored (0): it is already compressed. */
  level?: number;
  lastModified?: Date;
}

export interface ZipEntryRecord {
  name: string;
  size: number;
}

/**
 * Streams entries into a zip written to any `WritableStream` (a file picked with the File System Access
 * API, an OPFS file, a Node file stream, or memory). Entries are written one at a time, in the order they
 * are added, and nothing is buffered beyond zip.js's internal chunking.
 *
 * Every entry name is marked UTF-8 (general purpose bit 11). Telegram-iOS reads archives with
 * SSZipArchive, which decodes an unflagged name from a DOS-made archive as CP437; a mis-decoded name
 * would no longer match the `<attached: …>` reference in the chat text.
 */
export class ZipSink {
  private readonly writer: ZipWriter<unknown>;
  private readonly piping: Promise<void>;
  private readonly written: ZipEntryRecord[] = [];
  private readonly names = new Set<string>();
  private bytesOut = 0;

  constructor(
    destination: WritableStream<Uint8Array>,
    private readonly onProgress?: (p: ZipProgress) => void,
    /** Aborting it aborts the destination (an FS Access API file is then discarded). */
    signal?: AbortSignal,
  ) {
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        this.bytesOut += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    this.piping = counter.readable.pipeTo(destination, signal ? { signal } : {});
    // Surfaced by close(); without this an abort would also report an unhandled rejection.
    this.piping.catch(() => undefined);
    this.writer = new ZipWriter(counter.writable, {
      useWebWorkers: false,
      useCompressionStream: true,
      keepOrder: true,
    });
  }

  /** Names already used, so callers can keep archive names unique. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  get entries(): readonly ZipEntryRecord[] {
    return this.written;
  }

  async addBytes(name: string, data: Uint8Array, opts: ZipEntryOptions = {}): Promise<void> {
    this.claim(name);
    await this.writer.add(name, new Uint8ArrayReader(data), {
      level: opts.level ?? 6,
      useUnicodeFileNames: true,
      ...(opts.lastModified ? { lastModDate: opts.lastModified } : {}),
    });
    this.record(name, data.byteLength);
  }

  async addFile(name: string, file: SourceFile, opts: ZipEntryOptions = {}): Promise<void> {
    this.claim(name);
    await this.writer.add(name, file.stream(), {
      level: opts.level ?? 0,
      // A known size keeps the entry out of Zip64 below 4 GB.
      uncompressedSize: file.size,
      useUnicodeFileNames: true,
      ...(opts.lastModified ? { lastModDate: opts.lastModified } : {}),
    });
    this.record(name, file.size);
  }

  /** Writes the central directory and closes the destination. Returns the archive size in bytes. */
  async close(): Promise<number> {
    await this.writer.close();
    await this.piping;
    this.onProgress?.({ entries: this.written.length, bytes: this.bytesOut });
    return this.bytesOut;
  }

  private claim(name: string): void {
    if (this.names.has(name)) throw new Error(`Duplicate zip entry name: ${name}`);
    this.names.add(name);
  }

  private record(name: string, size: number): void {
    this.written.push({ name, size });
    this.onProgress?.({ entries: this.written.length, bytes: this.bytesOut });
  }
}

/** Collects a stream in memory — for tests and small archives. */
export function memoryWritable(): { writable: WritableStream<Uint8Array>; result: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
    },
  });
  return {
    writable,
    result: () => {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return out;
    },
  };
}
