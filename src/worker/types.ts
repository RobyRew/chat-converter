import type { Conversation, ExportFormatId, FidelityReport, PlatformId } from '../model';
import type { ExportArtifact, ExportOptions, InputFile } from '../engine/contracts';

/**
 * Worker message contract — pure types only (no `WebWorker`-lib globals), so DOM apps can
 * import these without a lib conflict. The worker now runs import and export as separate
 * actions, with the edit step happening on the main thread in between.
 */
export interface ImportRequest {
  id: string;
  action: 'import';
  file: InputFile;
  source?: PlatformId;
}

export interface ExportRequestMsg {
  id: string;
  action: 'export';
  conversation: Conversation;
  target: ExportFormatId;
  exportOptions?: ExportOptions;
}

export type WorkerRequest = ImportRequest | ExportRequestMsg;

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
    }
  | {
      id: string;
      ok: true;
      action: 'export';
      artifact: ExportArtifact;
      report: FidelityReport;
      warnings: string[];
    }
  | { id: string; ok: false; error: string };
