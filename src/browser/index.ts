/**
 * Browser-only helpers (DOM lib): turning drops and file inputs into `BlobEntry` lists the worker can
 * receive, and choosing where a package is written. Everything here passes `File` handles around; no
 * file is read on the main thread.
 */
import type { BlobEntry } from '../sources/blob';

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call (Chromium); keep calling until it returns none.
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          next();
        }
      }, reject);
    };
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collect(entry: FileSystemEntry, prefix: string, out: BlobEntry[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ path, blob: await fileOf(entry as FileSystemFileEntry) });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await collect(child, path, out);
  }
}

/**
 * Files from a drop, folders included. Paths keep the dropped folder as their first segment
 * (`ChatExport_2026-11-07/photos/…`); `makeSource` strips it again.
 */
export async function entriesFromDataTransfer(dt: DataTransfer): Promise<BlobEntry[]> {
  // Entries must be taken synchronously inside the drop handler, before any await.
  const roots = [...dt.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  const out: BlobEntry[] = [];
  if (roots.length === 0) {
    for (const f of [...dt.files]) out.push({ path: f.name, blob: f });
    return out;
  }
  for (const root of roots) await collect(root, '', out);
  return out;
}

/** Files from `<input type="file" webkitdirectory>` or a multi-file input. */
export function entriesFromFileList(list: FileList | readonly File[]): BlobEntry[] {
  return [...list].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }));
}

/** Name for the drop: the single top-level folder or file, else a generic label. */
export function dropName(entries: readonly BlobEntry[]): string {
  const tops = new Set(entries.map((e) => e.path.split('/')[0] ?? e.path));
  const [only] = tops;
  return tops.size === 1 && only ? only : 'Dropped files';
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
}

/** `true` when the browser can stream straight to a file the user picks (Chromium-based browsers). */
export function canPickSaveFile(): boolean {
  return typeof (window as unknown as SavePickerWindow).showSaveFilePicker === 'function';
}

/**
 * Asks where to save a zip. Must be called from a user gesture. Returns `null` when the user cancels.
 * The returned handle can be posted to the worker, which writes the archive straight to disk.
 */
export async function pickSaveFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as SavePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker({
      suggestedName,
      types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** Offers a file the worker wrote to OPFS as a normal download, then lets the caller delete it. */
export async function downloadFromOpfs(name: string, downloadName: string): Promise<() => Promise<void>> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  return async () => {
    URL.revokeObjectURL(url);
    await root.removeEntry(name).catch(() => undefined);
  };
}

/** Names the converter gives packages it writes into this site's browser storage (OPFS). */
const OPFS_OUTPUT = /^chat-converter-\d+\.zip$/;

/** `entries()` is declared by the DOM async-iterable lib, which consumers may not load; this is its shape. */
type DirectoryEntries = { entries(): AsyncIterable<[string, FileSystemHandle]> };

/**
 * Removes packages earlier conversions left in this site's browser storage (OPFS), except `keep`, and returns the
 * bytes removed. A file that a conversion in another tab is still writing is locked: removing it fails and it stays.
 */
export async function clearOpfsOutputs(keep?: string): Promise<number> {
  if (typeof navigator.storage?.getDirectory !== 'function') return 0;
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  for await (const [name, handle] of (root as unknown as DirectoryEntries).entries()) {
    if (handle.kind === 'file' && OPFS_OUTPUT.test(name) && name !== keep) names.push(name);
  }
  let freed = 0;
  for (const name of names) {
    try {
      const { size } = await (await root.getFileHandle(name)).getFile();
      await root.removeEntry(name);
      freed += size;
    } catch {
      // Locked by a running conversion, or already gone.
    }
  }
  return freed;
}
