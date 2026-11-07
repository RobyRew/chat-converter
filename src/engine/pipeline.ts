import type { Conversation, ExportFormatId, FidelityReport, PlatformId } from '../model';
import { defaultRegistry } from './builtins';
import {
  ConversionError,
  type DetectResult,
  type ExportArtifact,
  type ExportOptions,
  type ImportInput,
  type InputFile,
} from './contracts';
import { MediaStore } from './media';
import type { Registry } from './registry';
import { buildFidelityReport } from './fidelity';
import { isZip, unzip } from './zip';

export interface ImportOptions {
  /** Force the source platform instead of auto-detecting. */
  source?: PlatformId;
  registry?: Registry;
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
}

export interface ExportResult {
  artifact: ExportArtifact;
  report: FidelityReport;
  warnings: string[];
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

/** Unpacks a zip into its files, or wraps a single file. */
export function expandInput(file: InputFile, hint?: PlatformId): ImportInput {
  const files = isZip(file.bytes) ? unzip(file.bytes) : [file];
  return { files, hint };
}

/** Parse an export file into the canonical model. (First half of the pipeline.) */
export async function importConversation(file: InputFile, opts: ImportOptions = {}): Promise<ImportResult> {
  const reg = opts.registry ?? defaultRegistry;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  const input = expandInput(file, opts.source);
  const detected: DetectResult = opts.source
    ? { platform: opts.source, confidence: 1 }
    : reg.detect(input);

  const importer = reg.getImporter(detected.platform);
  if (!importer) {
    throw new ConversionError(`No importer registered for "${detected.platform}"`, 'NO_IMPORTER');
  }

  const media = new MediaStore();
  for (const f of input.files) media.set(f.name, f.bytes);

  const conversation = await importer.parse(input, { media, warn, hint: opts.source });
  return { conversation, detectedPlatform: detected.platform, warnings };
}

/** Serialize a (possibly edited) canonical conversation into a target format. (Second half.) */
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

  // v1 exporters reference media by file name, never by bytes — a fresh store is enough.
  const media = new MediaStore();
  const artifact = await exporter.serialize(conversation, { media, warn }, opts.exportOptions);
  const report = buildFidelityReport(exporter, conversation, warnings);
  return { artifact, report, warnings };
}

/** import → export in one shot. The one entry point for the no-edit path (used by the API + tests). */
export async function convert(file: InputFile, opts: ConvertOptions): Promise<ConvertResult> {
  const imported = await importConversation(file, { source: opts.source, registry: opts.registry });
  const exported = await exportConversation(imported.conversation, {
    target: opts.target,
    exportOptions: opts.exportOptions,
    registry: opts.registry,
  });
  return {
    conversation: imported.conversation,
    artifact: exported.artifact,
    report: exported.report,
    detectedPlatform: imported.detectedPlatform,
    warnings: [...imported.warnings, ...exported.warnings],
  };
}
