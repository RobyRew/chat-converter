import type { CapabilityMatrix, Conversation, ExportFormatId, PlatformId, UniversalChat } from '../model';
import type { ZipSink } from '../sinks/zip';
import type { Source, SourceFile } from '../sources/source';
import type { MediaStore } from './media';

/** A raw input file held in memory. A zip is opened as an archive. */
export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

/** A produced output file. */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

/** What an importer sees: the files of one export, read lazily. */
export interface ImportInput {
  source: Source;
  files: readonly SourceFile[];
  hint?: PlatformId;
}

export interface DetectResult {
  platform: PlatformId;
  /** 0..1 — how confident the importer is that the input is its format. */
  confidence: number;
  reason?: string;
}

export interface ParseContext {
  /** Every file of the export, keyed by path — importers check which referenced media exist. */
  media: MediaStore;
  warn: (message: string) => void;
  hint?: PlatformId;
  /** IANA zone used where a format only has local wall-clock times (e.g. Telegram's HTML export). */
  timeZone?: string;
}

/**
 * Turns one platform's export into the canonical model. Adding a platform = adding one file that
 * implements this interface and registering it (see `registry.ts`).
 */
export interface Importer {
  platform: PlatformId;
  capabilities: CapabilityMatrix;
  detect(input: ImportInput): Promise<DetectResult>;
  /** The first (or only) conversation of the export. */
  parse(input: ImportInput, ctx: ParseContext): Promise<Conversation>;
  /**
   * Every conversation of an account-wide export (Instagram, Messenger, Snapchat…), or a whole UniversalChat
   * document. Importers of single-chat exports leave it out; the pipeline then uses `parse`.
   */
  parseArchive?(input: ImportInput, ctx: ParseContext): Promise<Conversation[] | UniversalChat>;
}

/** Options for the WhatsApp-format packages (the `whatsapp`, `telegram-ios` and `telegram-android` targets). */
export interface WhatsAppPackageOptions {
  /** `dm` writes a private-chat export, `group` a group export. Defaults to the conversation kind. */
  mode?: 'dm' | 'group';
  /** Participant id written as the exporting user. Defaults to the most active participant who is not the peer. */
  selfId?: string;
  /** IANA zone for the written wall-clock times when a message carries no original offset. */
  timeZone?: string;
  /** Write calls, pins and other service events as text lines. Default true. */
  serviceAsText?: boolean;
  /** Write `‎image omitted`-style markers for media the export did not include. Default true. */
  omittedMarkers?: boolean;
  /** Prefix replies with a quote of the message they answer. Default false (WhatsApp exports have none). */
  replyQuotes?: boolean;
  /** Prefix forwarded messages with `Forwarded from <name>:`. Default false. */
  forwardLabels?: boolean;
  /** Append WhatsApp's `<This message was edited>` marker. Default false. */
  editedMarker?: boolean;
  /** Animated (`.tgs`) and video (`.webm`) stickers: `omit` writes `sticker omitted`, `file` attaches them as files. */
  animatedStickers?: 'omit' | 'file';
  /** Write the end-to-end-encryption notice line WhatsApp puts first. Default true. */
  noticeLine?: boolean;
}

export interface ExportOptions {
  includeMedia?: boolean;
  title?: string;
  /**
   * Message order of the output. WhatsApp-format packages are always written in the export's own
   * (chronological) order, as WhatsApp writes them; `newest-first` applies to the other formats.
   */
  order?: 'source' | 'oldest-first' | 'newest-first';
  whatsapp?: WhatsAppPackageOptions;
}

export interface ExportContext {
  /** Files of the source export (media is streamed from here by package exporters). */
  media: MediaStore;
  warn: (message: string) => void;
}

export interface ExportArtifact {
  files: OutputFile[];
  /** Suggested download filename for the primary artifact. */
  suggestedName: string;
  mime: string;
}

export interface PackageContext extends ExportContext {
  sink: ZipSink;
}

/** What a package exporter wrote, for the message/media invariants shown to the user. */
export interface PackageSummary {
  /** Suggested archive file name, e.g. `WhatsApp Chat - Sam Rivers.zip`. */
  suggestedName: string;
  messagesIn: number;
  messagesOut: number;
  mediaWritten: number;
  mediaOmitted: number;
  /** Archive entry names in write order. */
  entries: string[];
  /** Per-feature counts of what the target cannot carry (e.g. `reactions: 1372`). */
  dropped: Record<string, number>;
  /** Per-feature counts of what was rewritten to fit the target (e.g. `animatedStickers: 20`). */
  approximated: Record<string, number>;
}

export interface Exporter {
  format: ExportFormatId;
  capabilities: CapabilityMatrix;
  /**
   * Capabilities that are only partially representable (content survives, nuance is lost) —
   * reported as `approximated` rather than `dropped`.
   */
  approximates?: CapabilityMatrix;
  /** In-memory output (text formats; for package formats, the chat text alone). */
  serialize(conv: Conversation, ctx: ExportContext, opts?: ExportOptions): Promise<ExportArtifact>;
  /** Streams a complete package (chat text + media) into an archive. Only package formats have it. */
  write?(conv: Conversation, ctx: PackageContext, opts?: ExportOptions): Promise<PackageSummary>;
}

export class ConversionError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
  }
}
