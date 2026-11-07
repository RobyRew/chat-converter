import { createUniversalChat, isUniversalChat, type Conversation, type ExportFormatId, type FidelityReport, type PlatformId, type UniversalChat } from '../model';
import { ZipSink, type ZipProgress } from '../sinks/zip';
import { isSource, sourceFromInputFile, splitExports, type Source } from '../sources/index';
import { defaultRegistry } from './builtins';
import {
  ConversionError,
  type DetectResult,
  type ExportArtifact,
  type ExportOptions,
  type ImportInput,
  type InputFile,
  type PackageSummary,
} from './contracts';
import { buildFidelityReport } from './fidelity';
import { writeUniversalChatPackage } from '../exporters/universalchat';
import { orderMessages } from './transforms';
import { MediaStore } from './media';
import type { Registry } from './registry';

export interface ImportOptions {
  /** Force the source platform instead of auto-detecting. */
  source?: PlatformId;
  registry?: Registry;
  /** IANA zone for formats that only carry local wall-clock times (Telegram's HTML export). */
  timeZone?: string;
  /** When the input holds several exports, which one to import (see `listExports`). Default 0. */
  exportIndex?: number;
  /** For `importConversation` on an account-wide export: which conversation. Default 0. */
  conversationIndex?: number;
}

export interface ArchiveResult {
  archive: UniversalChat;
  detectedPlatform: PlatformId;
  warnings: string[];
  /** The export the archive was read from (media is streamed from it). */
  source: Source;
}

export interface ImportResult {
  conversation: Conversation;
  detectedPlatform: PlatformId;
  warnings: string[];
}

export interface ExportRequest {
  target: ExportFormatId;
  exportOptions?: ExportOptions;
  registry?: Registry;
  /** The export the conversation came from, for exporters that look at media. */
  source?: Source;
}

export interface ExportResult {
  artifact: ExportArtifact;
  report: FidelityReport;
  warnings: string[];
}

export interface PackageRequest {
  target: ExportFormatId;
  /** The export the conversation came from; media is streamed from it. */
  source: Source;
  destination: WritableStream<Uint8Array>;
  exportOptions?: ExportOptions;
  registry?: Registry;
  onProgress?: (p: ZipProgress) => void;
  signal?: AbortSignal;
}

export interface PackageResult {
  summary: PackageSummary;
  report: FidelityReport;
  warnings: string[];
  /** Size of the written archive in bytes. */
  archiveBytes: number;
}

export interface ConvertOptions {
  target: ExportFormatId;
  source?: PlatformId;
  exportOptions?: ExportOptions;
  registry?: Registry;
}

export interface ConvertResult {
  conversation: Conversation;
  artifact: ExportArtifact;
  report: FidelityReport;
  detectedPlatform: PlatformId;
  warnings: string[];
}

/** Opens an in-memory file (a zip becomes an archive source) or passes a `Source` through. */
export async function openInput(input: InputFile | Source): Promise<Source> {
  return isSource(input) ? input : sourceFromInputFile(input);
}

/** The exports found in an input — several when, e.g., three `ChatExport_*` folders were dropped together. */
export async function listExports(input: InputFile | Source): Promise<Source[]> {
  return splitExports(await openInput(input));
}

/** Reads an export into a UniversalChat archive: one conversation, or every conversation of an account export. */
export async function importArchive(input: InputFile | Source, opts: ImportOptions = {}): Promise<ArchiveResult> {
  const reg = opts.registry ?? defaultRegistry;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const exportsFound = await listExports(input);
  const source = exportsFound[opts.exportIndex ?? 0] ?? exportsFound[0];
  if (!source) throw new ConversionError('The input holds no files', 'EMPTY_INPUT');

  const importInput: ImportInput = { source, files: source.files };
  if (opts.source) importInput.hint = opts.source;
  const detected: DetectResult = opts.source
    ? { platform: opts.source, confidence: 1 }
    : await reg.detect(importInput);

  const importer = reg.getImporter(detected.platform);
  if (!importer || detected.confidence <= 0) {
    throw new ConversionError(
      `No importer recognised this export (${detected.reason ?? detected.platform})`,
      'NO_IMPORTER',
    );
  }

  const media = new MediaStore(source.files);
  const ctx: Parameters<typeof importer.parse>[1] = { media, warn };
  if (opts.source) ctx.hint = opts.source;
  if (opts.timeZone) ctx.timeZone = opts.timeZone;
  const parsed = importer.parseArchive ? await importer.parseArchive(importInput, ctx) : [await importer.parse(importInput, ctx)];
  const archive = isUniversalChat(parsed)
    ? parsed
    : createUniversalChat(parsed, {
        platform: detected.platform,
        name: source.name,
        ...(typeof parsed[0]?.meta?.['exportFormat'] === 'string' ? { variant: parsed[0].meta['exportFormat'] as string } : {}),
      });
  return { archive, detectedPlatform: detected.platform, warnings, source };
}

/** Parse an export into the canonical model. (First half of the pipeline.) */
export async function importConversation(
  input: InputFile | Source,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const { archive, detectedPlatform, warnings } = await importArchive(input, opts);
  const conversation = archive.conversations[opts.conversationIndex ?? 0];
  if (!conversation) throw new ConversionError('The export holds no conversation', 'EMPTY_EXPORT');
  return { conversation, detectedPlatform, warnings };
}

/** Serialize a (possibly edited) canonical conversation into an in-memory artifact. (Second half.) */
export async function exportConversation(conversation: Conversation, opts: ExportRequest): Promise<ExportResult> {
  const reg = opts.registry ?? defaultRegistry;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const exporter = reg.getExporter(opts.target);
  if (!exporter) {
    throw new ConversionError(`No exporter registered for "${opts.target}"`, 'NO_EXPORTER');
  }

  const media = new MediaStore(opts.source?.files ?? []);
  const ordered = exporter.write ? conversation : orderMessages(conversation, opts.exportOptions?.order);
  const artifact = await exporter.serialize(ordered, { media, warn }, opts.exportOptions);
  const report = buildFidelityReport(exporter, ordered, warnings);
  return { artifact, report, warnings };
}

/** Streams a complete package (chat text + media) for package targets into `destination`. */
export async function writePackage(conversation: Conversation, req: PackageRequest): Promise<PackageResult> {
  const reg = req.registry ?? defaultRegistry;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const exporter = reg.getExporter(req.target);
  if (!exporter?.write) {
    throw new ConversionError(`"${req.target}" is not a package format`, 'NOT_A_PACKAGE');
  }

  if (req.exportOptions?.order === 'newest-first') {
    warn('WhatsApp-format packages keep the chronological order WhatsApp writes; "newest first" was not applied.');
  }
  const sink = new ZipSink(req.destination, req.onProgress, req.signal);
  const media = new MediaStore(req.source.files);
  const summary = await exporter.write(conversation, { media, warn, sink }, req.exportOptions);
  const archiveBytes = await sink.close();
  const report = buildFidelityReport(exporter, conversation, warnings);
  return { summary, report, warnings, archiveBytes };
}

/** import → export in one shot. The one entry point for the no-edit path (used by the API + tests). */
export async function convert(file: InputFile | Source, opts: ConvertOptions): Promise<ConvertResult> {
  const importOpts: ImportOptions = {};
  if (opts.source) importOpts.source = opts.source;
  if (opts.registry) importOpts.registry = opts.registry;
  const imported = await importConversation(file, importOpts);
  const exportReq: ExportRequest = { target: opts.target };
  if (opts.exportOptions) exportReq.exportOptions = opts.exportOptions;
  if (opts.registry) exportReq.registry = opts.registry;
  const exported = await exportConversation(imported.conversation, exportReq);
  return {
    conversation: imported.conversation,
    artifact: exported.artifact,
    report: exported.report,
    detectedPlatform: imported.detectedPlatform,
    warnings: [...imported.warnings, ...exported.warnings],
  };
}

/**
 * Streams several conversations (or a whole account export) into one UniversalChat package, media included.
 */
export async function writeArchivePackage(
  archive: UniversalChat,
  req: Omit<PackageRequest, 'target' | 'exportOptions' | 'registry'>,
): Promise<{ archiveBytes: number; mediaWritten: number; mediaMissing: number; entries: string[] }> {
  const sink = new ZipSink(req.destination, req.onProgress, req.signal);
  const r = await writeUniversalChatPackage(archive, new MediaStore(req.source.files), sink);
  const archiveBytes = await sink.close();
  return { archiveBytes, ...r };
}
