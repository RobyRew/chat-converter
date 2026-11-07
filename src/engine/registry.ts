import type { ExportFormatId, PlatformId } from '../model';
import type { DetectResult, Exporter, Importer, ImportInput } from './contracts';

/** Maps platform → importer and format → exporter. The single extension point of the engine. */
export class Registry {
  private readonly importers = new Map<PlatformId, Importer>();
  private readonly exporters = new Map<ExportFormatId, Exporter>();

  registerImporter(importer: Importer): this {
    this.importers.set(importer.platform, importer);
    return this;
  }

  registerExporter(exporter: Exporter): this {
    this.exporters.set(exporter.format, exporter);
    return this;
  }

  getImporter(platform: PlatformId): Importer | undefined {
    return this.importers.get(platform);
  }

  getExporter(format: ExportFormatId): Exporter | undefined {
    return this.exporters.get(format);
  }

  listImporters(): Importer[] {
    return [...this.importers.values()];
  }

  listExporters(): Exporter[] {
    return [...this.exporters.values()];
  }

  /** Runs every importer's detector and returns the highest-confidence match. */
  detect(input: ImportInput): DetectResult {
    let best: DetectResult = { platform: 'generic', confidence: 0, reason: 'no importer matched' };
    for (const importer of this.importers.values()) {
      const r = importer.detect(input);
      if (r.confidence > best.confidence) best = r;
    }
    return best;
  }
}
