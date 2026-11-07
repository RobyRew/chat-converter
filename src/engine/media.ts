/**
 * Holds media bytes referenced by a conversation, keyed by `ref` (usually the file name
 * inside the source archive). Isomorphic: an in-memory map works in browser and Node.
 * A future enhancement can back this with OPFS/IndexedDB (browser) or tmpfs (server sandbox).
 */
export class MediaStore {
  private readonly map = new Map<string, Uint8Array>();

  set(ref: string, bytes: Uint8Array): void {
    this.map.set(ref, bytes);
  }

  get(ref: string): Uint8Array | undefined {
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
