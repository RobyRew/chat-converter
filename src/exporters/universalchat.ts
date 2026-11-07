import {
  capabilities,
  createUniversalChat,
  type Attachment,
  type CapabilityMatrix,
  type Conversation,
  type MediaItem,
  type UniversalChat,
} from '../model';
import type { Exporter, PackageSummary } from '../engine/contracts';
import { slug } from '../engine/format';
import type { MediaStore } from '../engine/media';
import { strToU8 } from '../engine/zip';
import type { ZipSink } from '../sinks/zip';
import type { SourceFile } from '../sources/source';

/** UniversalChat holds everything the model holds. */
const full = Object.fromEntries(capabilities.map((c) => [c, true])) as CapabilityMatrix;

/** Where conversation `index`'s file `ref` goes inside a package. */
export function packagePath(index: number, ref: string): string {
  return `media/${index}/${ref.replace(/^\/+/, '')}`;
}

/** The path the export originally used (kept when a package is read back and refs point into it). */
function originalRef(a: Attachment): string | undefined {
  const v = a.ext?.['universalchat']?.['originalRef'];
  return typeof v === 'string' ? v : a.ref;
}

interface PlannedFile {
  path: string;
  file: SourceFile;
  lastModified: Date;
}

/** Adds a media manifest to every conversation and lists the files a package must carry. */
function plan(archive: UniversalChat, media: MediaStore): { doc: UniversalChat; files: PlannedFile[]; missing: number } {
  const files: PlannedFile[] = [];
  const written = new Set<string>();
  let missing = 0;
  const conversations = archive.conversations.map((c, index) => {
    const manifest: MediaItem[] = [];
    const seen = new Set<string>();
    const add = (current: string | undefined, original: string | undefined, ts: number, mimeType?: string): void => {
      if (!current || seen.has(current)) return;
      seen.add(current);
      const ref = original ?? current;
      const file = media.get(current);
      if (!file || file.size === 0) {
        manifest.push({ ref, present: false });
        missing++;
        return;
      }
      const path = packagePath(index, ref);
      manifest.push({ ref, path, size: file.size, present: true, ...(mimeType ? { mimeType } : {}) });
      if (!written.has(path)) {
        written.add(path);
        files.push({ path, file, lastModified: new Date(ts) });
      }
    };
    for (const m of c.messages) {
      for (const a of m.attachments ?? []) {
        if (a.present === false) continue;
        add(a.ref, originalRef(a), m.ts, a.mimeType);
        add(a.thumbnailRef, a.thumbnailRef, m.ts);
      }
      if (m.contact?.vcardRef) add(m.contact.vcardRef, m.contact.vcardRef, m.ts, 'text/vcard');
    }
    for (const p of c.participants) add(p.avatarRef, p.avatarRef, 0);
    return { ...c, media: manifest };
  });
  return { doc: { ...archive, conversations }, files, missing };
}

/** Streams a UniversalChat package: `universalchat.json` first, then every media file under `media/`. */
export async function writeUniversalChatPackage(
  archive: UniversalChat,
  media: MediaStore,
  sink: ZipSink,
): Promise<{ mediaWritten: number; mediaMissing: number; entries: string[] }> {
  const { doc, files, missing } = plan(archive, media);
  await sink.addBytes('universalchat.json', strToU8(JSON.stringify(doc)), { level: 6 });
  for (const f of files) await sink.addFile(f.path, f.file, { level: 0, lastModified: f.lastModified });
  return { mediaWritten: files.length, mediaMissing: missing, entries: sink.entries.map((e) => e.name) };
}

function fileStem(conv: Conversation): string {
  return slug(conv.title, 'chat');
}

/** `universalchat`: the archive as one JSON document, without media bytes. */
export const universalchatExporter: Exporter = {
  format: 'universalchat',
  capabilities: full,
  async serialize(conv, ctx) {
    const { doc } = plan(createUniversalChat([conv]), ctx.media);
    return {
      files: [{ name: 'universalchat.json', bytes: strToU8(JSON.stringify(doc)) }],
      suggestedName: `${fileStem(conv)}.universalchat.json`,
      mime: 'application/json',
    };
  },
};

/** `universalchat-zip`: the archive plus every media file — the lossless package. */
export const universalchatZipExporter: Exporter = {
  format: 'universalchat-zip',
  capabilities: full,
  async serialize(conv, ctx) {
    const { doc } = plan(createUniversalChat([conv]), ctx.media);
    return {
      files: [{ name: 'universalchat.json', bytes: strToU8(JSON.stringify(doc)) }],
      suggestedName: `${fileStem(conv)}.universalchat.zip`,
      mime: 'application/json',
    };
  },
  async write(conv, ctx): Promise<PackageSummary> {
    const r = await writeUniversalChatPackage(createUniversalChat([conv]), ctx.media, ctx.sink);
    return {
      suggestedName: `${fileStem(conv)}.universalchat.zip`,
      messagesIn: conv.messages.length,
      messagesOut: conv.messages.length,
      mediaWritten: r.mediaWritten,
      mediaOmitted: r.mediaMissing,
      entries: r.entries,
      dropped: {},
      approximated: {},
    };
  },
};
