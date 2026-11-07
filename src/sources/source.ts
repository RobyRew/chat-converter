/**
 * Lazy view of an export: a folder the user dropped, a zip, or files held in memory.
 *
 * Importers read only the chat file(s) (JSON / HTML / TXT); media stays a handle until an exporter
 * streams it into an archive. That is what lets a multi-GB export with thousands of photos go through a
 * browser tab without being loaded into memory.
 */
export interface SourceFile {
  /** '/'-separated path relative to the export root, without a leading slash. */
  readonly path: string;
  /** Size in bytes. */
  readonly size: number;
  /** Reads the whole file. Meant for chat files, not for media. */
  bytes(): Promise<Uint8Array>;
  /** Streams the file; used when copying media into an archive. */
  stream(): ReadableStream<Uint8Array>;
  /** Reads up to the first `n` bytes (cheap for disk-backed files). */
  head(n: number): Promise<Uint8Array>;
}

export interface Source {
  /** Display name: the dropped folder or archive name, without extension. */
  readonly name: string;
  readonly files: readonly SourceFile[];
  /**
   * Folders stripped from every path ('/'-joined, no trailing slash), e.g. `your_instagram_activity/messages`
   * when only that folder was dropped. Exports that reference files by their path from the export's own root
   * (Meta, Snapchat) put it back to find threads and media.
   */
  readonly root?: string;
}

/** A file's path with the stripped folders put back. */
export function fullPath(source: Pick<Source, 'root'>, path: string): string {
  return source.root ? `${source.root}/${path}` : path;
}

const JUNK = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$|(?:^|\/)__MACOSX\//;

/** Finder/Explorer metadata and AppleDouble files that are never part of an export. */
export function isJunk(path: string): boolean {
  return JUNK.test(path);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

export function extensionOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** Normalises separators and strips leading `./` and `/`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

const decoder = new TextDecoder('utf-8');

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export async function readText(file: SourceFile): Promise<string> {
  return decodeUtf8(await file.bytes());
}

export async function readHeadText(file: SourceFile, n: number): Promise<string> {
  return decodeUtf8(await file.head(n));
}

/** A `SourceFile` whose path is re-rooted (used when stripping a common top-level folder). */
function rebase(file: SourceFile, path: string): SourceFile {
  return {
    path,
    size: file.size,
    bytes: () => file.bytes(),
    stream: () => file.stream(),
    head: (n) => file.head(n),
  };
}

/**
 * Builds a `Source`: drops junk entries and strips top-level folders shared by every file, so a dropped
 * `ChatExport_2026-11-07/` folder and a zip of that folder both yield `result.json`, `photos/…`.
 * The stripped folder name becomes the source name when it is more specific than `fallbackName`.
 */
export function makeSource(fallbackName: string, files: readonly SourceFile[]): Source {
  let list = files.filter((f) => f.path && !isJunk(f.path));
  let name = fallbackName;
  const stripped: string[] = [];
  for (;;) {
    const first = list[0];
    if (!first) break;
    const seg = first.path.split('/')[0] ?? '';
    const prefix = seg + '/';
    if (!seg || !list.every((f) => f.path.startsWith(prefix) && f.path.length > prefix.length)) break;
    list = list.map((f) => rebase(f, f.path.slice(prefix.length)));
    stripped.push(seg);
    name = seg;
  }
  return stripped.length ? { name, files: list, root: stripped.join('/') } : { name, files: list };
}

/** Marker files that identify an export root. */
function isExportMarker(path: string): boolean {
  const b = baseName(path);
  return b === 'result.json' || b === 'messages.html' || /\.txt$/i.test(b);
}

/**
 * When several exports are dropped at once (e.g. three `ChatExport_*` folders), returns one `Source`
 * per export. A source whose root already holds an export marker is returned as is.
 */
export function splitExports(source: Source): Source[] {
  if (source.files.some((f) => !f.path.includes('/') && isExportMarker(f.path))) return [source];
  const groups = new Map<string, SourceFile[]>();
  for (const f of source.files) {
    const i = f.path.indexOf('/');
    if (i < 0) continue;
    const top = f.path.slice(0, i);
    const list = groups.get(top) ?? [];
    list.push(rebase(f, f.path.slice(i + 1)));
    groups.set(top, list);
  }
  const out: Source[] = [];
  for (const [top, list] of groups) {
    if (list.some((f) => !f.path.includes('/') && isExportMarker(f.path))) {
      const root = source.root ? `${source.root}/${top}` : top;
      out.push({ name: top, files: list, root });
    }
  }
  return out.length ? out : [source];
}

export function isSource(value: unknown): value is Source {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Source).files) &&
    typeof (value as Source).name === 'string'
  );
}
