import type { Conversation, ExportFormatId, FidelityReport, PlatformId } from '../model';
import type { ExportArtifact, ExportOptions, InputFile, PackageSummary } from '../engine/contracts';
import type { Edits } from '../engine/transforms';
import type { ArchiveSummary, ConversationSummary, SearchHit } from '../engine/summary';
import type { BatchFile } from '../engine/batch';

/**
 * Worker message contract — pure types only (no `WebWorker`-lib globals), so DOM apps can import
 * these without a lib conflict.
 *
 * Flow: `import` (files → a UniversalChat archive of one or many conversations; the worker keeps the archive
 * and the file handles under the request id, and answers with one summary per conversation) → `open` a
 * conversation → edits on the main thread → `export` (in-memory text formats), `package` (a zip with media
 * streamed to a file the user picked, or to OPFS when the browser has no save picker) or `batch` (several
 * conversations into one download). `search` looks through every message of the archive.
 */

/** What the user gave us: one in-memory file (a zip opens as an archive) or dropped files/folders. */
export type WorkerInput =
  | { kind: 'bytes'; file: InputFile }
  | {
      kind: 'files';
      /** Display name of what was dropped. */
      name: string;
      /** `File` objects are handles: posting them to the worker does not copy their bytes. */
      entries: Array<{ path: string; file: Blob }>;
    };

export interface ImportRequest {
  id: string;
  action: 'import';
  input?: WorkerInput;
  /** Older single-file form, kept for callers written before `input`. */
  file?: InputFile;
  source?: PlatformId;
  timeZone?: string;
  /** Which export to import when the input holds several. Default 0. */
  exportIndex?: number;
}

export interface OpenRequestMsg {
  id: string;
  action: 'open';
  importId: string;
  /** Index into the import's `conversations`. */
  index: number;
}

export interface SearchRequestMsg {
  id: string;
  action: 'search';
  importId: string;
  query: string;
  limit?: number;
}

export interface ExportRequestMsg {
  id: string;
  action: 'export';
  /** The conversation to export; omit it to use the one the worker kept for `importId`. */
  conversation?: Conversation;
  /** Which of the import's conversations; default: the one last opened. */
  conversationIndex?: number;
  /** Id of the `import` request: its files supply media and, without `conversation`, its conversation. */
  importId?: string;
  /** Edits applied to the kept conversation before export (renames, title, date range…). */
  edits?: Edits;
  target: ExportFormatId;
  exportOptions?: ExportOptions;
}

/** Where a package is written. */
export type PackageDestination =
  /** A file chosen with `showSaveFilePicker()` (Chromium); its handle can be posted to a worker. */
  | { kind: 'handle'; handle: FileSystemFileHandleLike }
  /** A file in the origin-private file system; the page then offers it as a download. */
  | { kind: 'opfs'; name: string };

/** Structural stand-in for `FileSystemFileHandle`, so this file needs neither the DOM nor the WebWorker lib. */
export interface FileSystemFileHandleLike {
  readonly kind: 'file';
  readonly name: string;
}

export interface PackageRequestMsg {
  id: string;
  action: 'package';
  /** Id of the `import` request whose files hold the media. */
  importId: string;
  /** The conversation to write; omit it to use the one the worker kept for `importId`. */
  conversation?: Conversation;
  /** Which of the import's conversations; default: the one last opened. */
  conversationIndex?: number;
  edits?: Edits;
  target: ExportFormatId;
  exportOptions?: ExportOptions;
  destination: PackageDestination;
}

export interface BatchRequestMsg {
  id: string;
  action: 'batch';
  importId: string;
  /** The conversations to convert, each with its own edits and options. */
  items: Array<{ index: number; edits?: Edits; exportOptions?: ExportOptions }>;
  target: ExportFormatId;
  destination: PackageDestination;
}

export interface CancelRequestMsg {
  id: string;
  action: 'cancel';
  /** Id of the `package` request to stop. */
  requestId: string;
}

export interface ReleaseRequestMsg {
  id: string;
  action: 'release';
  /** Id of the `import` request whose file handles can be dropped. */
  importId: string;
}

export type WorkerRequest =
  | ImportRequest
  | OpenRequestMsg
  | SearchRequestMsg
  | ExportRequestMsg
  | PackageRequestMsg
  | BatchRequestMsg
  | CancelRequestMsg
  | ReleaseRequestMsg;

export interface ConversationMeta {
  title?: string;
  kind: string;
  messageCount: number;
  participantCount: number;
}

export type WorkerResponse =
  | {
      id: string;
      ok: true;
      action: 'import';
      conversation: Conversation;
      detectedPlatform: string;
      warnings: string[];
      meta: ConversationMeta;
      /** Names of every export found in the input (several when several folders were dropped). */
      exports: string[];
      /** Name of the export that was imported. */
      sourceName: string;
      /** The whole export: one summary per conversation, in archive order (latest activity first for account exports). */
      archive: ArchiveSummary;
      conversations: ConversationSummary[];
      /** Index of `conversation` in `conversations`. */
      index: number;
    }
  | { id: string; ok: true; action: 'open'; index: number; conversation: Conversation; meta: ConversationMeta }
  | { id: string; ok: true; action: 'search'; hits: SearchHit[]; total: number }
  | {
      id: string;
      ok: true;
      action: 'batch';
      suggestedName: string;
      layout: 'universalchat' | 'zip-of-files';
      conversations: number;
      messagesIn: number;
      messagesOut: number;
      mediaWritten: number;
      files: BatchFile[];
      warnings: string[];
      archiveBytes: number;
      opfsName?: string;
    }
  | {
      id: string;
      ok: true;
      action: 'export';
      artifact: ExportArtifact;
      report: FidelityReport;
      warnings: string[];
    }
  | { id: string; ok: true; action: 'progress'; entries: number; bytes: number }
  | {
      id: string;
      ok: true;
      action: 'package';
      summary: PackageSummary;
      report: FidelityReport;
      warnings: string[];
      archiveBytes: number;
      /** Set when the package was written to OPFS. */
      opfsName?: string;
    }
  | { id: string; ok: true; action: 'cancel' | 'release' }
  | { id: string; ok: false; error: string; code?: string };
