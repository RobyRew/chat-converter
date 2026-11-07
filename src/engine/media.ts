import type { SourceFile } from '../sources/source';

/**
 * Index of the files in an export, keyed by path relative to the export root (the same string a
 * conversation stores in `Attachment.ref`). Holds handles, never bytes: a file is read only when an
 * exporter streams it.
 */
export class MediaStore {
  private readonly map = new Map<string, SourceFile>();

  constructor(files: Iterable<SourceFile> = []) {
    for (const f of files) this.map.set(f.path, f);
  }

  set(file: SourceFile): void {
    this.map.set(file.path, file);
  }

  get(ref: string): SourceFile | undefined {
    return this.map.get(ref);
  }

  has(ref: string): boolean {
    return this.map.has(ref);
  }

  list(): string[] {
    return [...this.map.keys()];
  }

  get size(): number {
    return this.map.size;
  }
}
