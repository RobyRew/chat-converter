import type { Conversation, ExportFormatId, FidelityReport, PlatformId } from '../model';
import type { ExportArtifact, ExportOptions, InputFile, PackageSummary } from '../engine/contracts';

/**
 * Worker message contract — pure types only (no `WebWorker`-lib globals), so DOM apps can import
 * these without a lib conflict.
 *
 * Flow: `import` (files → canonical model; the worker keeps the file handles under the request id) →
 * edits on the main thread → `export` (in-memory text formats) or `package` (a zip with media streamed
 * to a file the user picked, or to OPFS when the browser has no save picker).
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

export interface ExportRequestMsg {
  id: string;
  action: 'export';
  conversation: Conversation;
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
  conversation: Conversation;
  target: ExportFormatId;
  exportOptions?: ExportOptions;
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

export type WorkerRequest = ImportRequest | ExportRequestMsg | PackageRequestMsg | CancelRequestMsg | ReleaseRequestMsg;

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
