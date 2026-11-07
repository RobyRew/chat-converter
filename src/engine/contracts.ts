import type {
  CapabilityMatrix,
  Conversation,
  ExportFormatId,
  PlatformId,
} from '../model';
import type { MediaStore } from './media';

/** A raw input file (already extracted from any archive). */
export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

/** A produced output file. */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

/** Expanded import payload handed to importers (a zip is pre-unpacked into `files`). */
export interface ImportInput {
  files: InputFile[];
  hint?: PlatformId;
}

export interface DetectResult {
  platform: PlatformId;
  /** 0..1 — how confident the importer is that the input is its format. */
  confidence: number;
  reason?: string;
}

export interface ParseContext {
  media: MediaStore;
  warn: (message: string) => void;
  hint?: PlatformId;
}

/**
 * Turns one platform's export into the canonical model. Adding a platform = adding one
 * file that implements this interface and registering it (see `registry.ts`).
 */
export interface Importer {
  platform: PlatformId;
  capabilities: CapabilityMatrix;
  detect(input: ImportInput): DetectResult;
  parse(input: ImportInput, ctx: ParseContext): Promise<Conversation>;
}

export interface ExportOptions {
  includeMedia?: boolean;
  title?: string;
}

export interface ExportContext {
  media: MediaStore;
  warn: (message: string) => void;
}

export interface ExportArtifact {
  files: OutputFile[];
  /** Suggested download filename for the primary artifact. */
  suggestedName: string;
  mime: string;
}

export interface Exporter {
  format: ExportFormatId;
  capabilities: CapabilityMatrix;
  /**
   * Capabilities that are only partially representable (content survives, nuance is lost) —
   * reported as `approximated` rather than `dropped`.
   */
  approximates?: CapabilityMatrix;
  serialize(conv: Conversation, ctx: ExportContext, opts?: ExportOptions): Promise<ExportArtifact>;
}

export class ConversionError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
  }
}
