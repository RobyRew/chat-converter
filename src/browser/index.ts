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

/** Safari on macOS or iOS, by user agent; used only for Safari-specific advice. */
export function isSafari(): boolean {
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|Edg\/|OPR\//.test(ua);
}

/** The service worker that streams downloads (src/ui/download-sw.js); bundlers emit it as an asset. */
const DOWNLOAD_WORKER_URL = new URL('../ui/download-sw.js', import.meta.url);

let downloadRegistration: Promise<ServiceWorkerRegistration | undefined> | undefined;
let streamingUnavailable = false;

function registerDownloadWorker(): Promise<ServiceWorkerRegistration | undefined> {
  downloadRegistration ??= (async () => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return undefined;
    if (DOWNLOAD_WORKER_URL.protocol === 'data:') {
      console.warn('chat-converter: the bundler inlined download-sw.js as a data: URL (assetsInlineLimit), so streamed downloads are off.');
      return undefined;
    }
    try {
      const reg = await navigator.serviceWorker.register(DOWNLOAD_WORKER_URL);
      const next = reg.installing ?? reg.waiting;
      if (next) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          const check = (): void => {
            if (next.state !== 'activated' && next.state !== 'redundant') return;
            clearTimeout(timer);
            resolve();
          };
          next.addEventListener('statechange', check);
          check();
        });
      }
      return reg.active ? reg : undefined;
    } catch {
      return undefined;
    }
  })();
  return downloadRegistration;
}

export interface StreamedDownload {
  /** Port the converter worker writes the package into; transfer it with the job. */
  readonly port: MessagePort;
  /** Resolves when the browser has received the whole file, rejects when it stopped receiving it. */
  readonly done: Promise<void>;
  /** Stops the keep-alive; the hidden frame is removed a minute later. */
  dispose(): void;
}

/**
 * Starts a download that the converter streams through download-sw.js, for browsers without a save dialog
 * (Safari 15.4+, Firefox): the file goes into the browser's downloads as it is written, with no copy in memory
 * or in site storage. Undefined when this browser cannot — no service worker, or the download did not start
 * within 10 seconds — and the caller falls back to browser storage; a failure is remembered for the page's
 * lifetime.
 */
export async function startStreamedDownload(fileName: string): Promise<StreamedDownload | undefined> {
  if (streamingUnavailable) return undefined;
  const reg = await registerDownloadWorker();
  const sw = reg?.active;
  if (!reg || !sw) {
    streamingUnavailable = true;
    return undefined;
  }
  const id = crypto.randomUUID();
  const data = new MessageChannel();
  const control = new MessageChannel();
  let markStarted = (): void => undefined;
  const started = new Promise<boolean>((resolve) => {
    markStarted = () => resolve(true);
    setTimeout(() => resolve(false), 10_000);
  });
  let finish = (): void => undefined;
  let fail = (_e: Error): void => undefined;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  control.port1.onmessage = (e: MessageEvent<{ type?: string; reason?: string }>) => {
    if (e.data?.type === 'started') markStarted();
    else if (e.data?.type === 'closed') finish();
    else if (e.data?.type === 'cancelled') fail(new Error(e.data.reason ? `The download stopped: ${e.data.reason}` : 'The download was cancelled.'));
  };
  sw.postMessage({ type: 'cc-download', id, name: fileName }, [data.port2, control.port2]);
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'Download';
  frame.src = new URL(`cc-download/${id}/${encodeURIComponent(fileName)}`, reg.scope).href;
  document.body.append(frame);
  const keepAlive = setInterval(() => reg.active?.postMessage({ type: 'cc-keepalive' }), 10_000);
  const dispose = (): void => {
    clearInterval(keepAlive);
    control.port1.close();
    // A browser may stop a download whose frame goes away, so the frame outlives the end by a minute.
    setTimeout(() => frame.remove(), 60_000);
  };
  if (!(await started)) {
    streamingUnavailable = true;
    dispose();
    data.port1.close();
    return undefined;
  }
  return { port: data.port1, done, dispose };
}
