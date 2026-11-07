import { createUniversalChat, FORMAT_META, packageFormatIds, type Conversation, type ExportFormatId, type UniversalChat } from '../model';
import { ZipSink, type ZipProgress } from '../sinks/zip';
import type { Source } from '../sources/index';
import { writeUniversalChatPackage } from '../exporters/universalchat';
import { archiveName, guessSelf, sanitizeFileName } from '../exporters/whatsapp-format';
import type { ExportOptions } from './contracts';
import { MediaStore } from './media';
import { exportConversation, writePackage } from './pipeline';
import type { Registry } from './registry';
import { strToU8 } from './zip';
import { batchFileName } from './batch-name';

export { batchFileName };

/**
 * Converts several conversations of one export in one go.
 *
 * - UniversalChat targets write ONE document (or package) holding every selected conversation.
 * - Package targets (WhatsApp/Telegram-import zips) write a zip of zips: each conversation's package is
 *   streamed, as it is being written, into its own entry of the outer zip, so nothing is held in memory.
 *   Each inner zip is the file to share to Telegram.
 * - Text targets write a zip with one file per conversation.
 */

export interface BatchItem {
  conversation: Conversation;
  exportOptions?: ExportOptions;
}

export interface BatchRequest {
  target: ExportFormatId;
  /** The export the conversations came from; media is streamed from it. */
  source: Source;
  destination: WritableStream<Uint8Array>;
  /** Name used for the download (the export's name). */
  name?: string;
  /** Recorded as the UniversalChat document's `source`. */
  archiveSource?: UniversalChat['source'];
  registry?: Registry;
  onProgress?: (p: ZipProgress) => void;
  signal?: AbortSignal;
}

export interface BatchFile {
  name: string;
  /** Index of the conversation in the batch. */
  item: number;
  bytes: number;
  messagesOut: number;
}

export interface BatchResult {
  layout: 'universalchat' | 'zip-of-files';
  suggestedName: string;
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  mediaWritten: number;
  files: BatchFile[];
  warnings: string[];
  archiveBytes: number;
}

/** The name the package exporters give a conversation's zip, worked out before writing it. */
function packageName(conv: Conversation, opts: ExportOptions | undefined): string {
  const self = opts?.whatsapp?.selfId ?? guessSelf(conv);
  const peer = conv.participants.find((p) => p.id !== self);
  const dm = (opts?.whatsapp?.mode ?? (conv.kind === 'dm' ? 'dm' : 'group')) === 'dm';
  return archiveName(opts?.title ?? (dm ? peer?.displayName : conv.title) ?? conv.title ?? 'Chat');
}

function uniqueNames(): (name: string) => string {
  const used = new Set<string>();
  return (name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.endsWith('.universalchat.json') ? name.length - '.universalchat.json'.length : name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 2; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };
}

export async function writeBatch(items: readonly BatchItem[], req: BatchRequest): Promise<BatchResult> {
  const warnings: string[] = [];
  const messagesIn = items.reduce((n, i) => n + i.conversation.messages.length, 0);
  const suggestedName = batchFileName(req.target, req.name, items.length);
  const label = (c: Conversation): string => c.title ?? 'Untitled';

  if (req.target === 'universalchat' || req.target === 'universalchat-zip') {
    const archive = createUniversalChat(items.map((i) => i.conversation), req.archiveSource);
    if (req.target === 'universalchat') {
      const writer = req.destination.getWriter();
      const bytes = strToU8(JSON.stringify(archive));
      await writer.write(bytes);
      await writer.close();
      return { layout: 'universalchat', suggestedName, conversations: items.length, messagesIn, messagesOut: messagesIn, mediaWritten: 0, files: [], warnings, archiveBytes: bytes.byteLength };
    }
    const sink = new ZipSink(req.destination, req.onProgress, req.signal);
    const r = await writeUniversalChatPackage(archive, new MediaStore(req.source.files), sink);
    const archiveBytes = await sink.close();
    if (r.mediaMissing) warnings.push(`${r.mediaMissing} referenced media file(s) are not in the export.`);
    return { layout: 'universalchat', suggestedName, conversations: items.length, messagesIn, messagesOut: messagesIn, mediaWritten: r.mediaWritten, files: [], warnings, archiveBytes };
  }

  const sink = new ZipSink(req.destination, req.onProgress, req.signal);
  const unique = uniqueNames();
  const files: BatchFile[] = [];
  let messagesOut = 0;
  let mediaWritten = 0;
  const isPackage = packageFormatIds.includes(req.target);
  for (const [n, item] of items.entries()) {
    req.signal?.throwIfAborted();
    const conv = item.conversation;
    if (isPackage) {
      const name = unique(packageName(conv, item.exportOptions));
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const [bytes, result] = await Promise.all([
        sink.addStream(name, pipe.readable, { lastModified: new Date(conv.messages.at(-1)?.ts ?? Date.now()) }),
        writePackage(conv, {
          target: req.target,
          source: req.source,
          destination: pipe.writable,
          ...(item.exportOptions ? { exportOptions: item.exportOptions } : {}),
          ...(req.registry ? { registry: req.registry } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        }),
      ]);
      messagesOut += result.summary.messagesOut;
      mediaWritten += result.summary.mediaWritten;
      for (const w of result.warnings) warnings.push(`${label(conv)}: ${w}`);
      files.push({ name, item: n, bytes, messagesOut: result.summary.messagesOut });
      continue;
    }
    const { artifact, warnings: w } = await exportConversation(conv, {
      target: req.target,
      source: req.source,
      ...(item.exportOptions ? { exportOptions: item.exportOptions } : {}),
      ...(req.registry ? { registry: req.registry } : {}),
    });
    for (const x of w) warnings.push(`${label(conv)}: ${x}`);
    const stem = sanitizeFileName(item.exportOptions?.title ?? label(conv), 100);
    for (const f of artifact.files) {
      const name = unique(artifact.files.length === 1 ? `${stem}.${FORMAT_META[req.target].extension}` : `${stem}/${f.name}`);
      await sink.addBytes(name, f.bytes, { lastModified: new Date(conv.messages.at(-1)?.ts ?? Date.now()) });
      files.push({ name, item: n, bytes: f.bytes.byteLength, messagesOut: conv.messages.length });
    }
    messagesOut += conv.messages.length;
  }
  const archiveBytes = await sink.close();
  return { layout: 'zip-of-files', suggestedName, conversations: items.length, messagesIn, messagesOut, mediaWritten, files, warnings, archiveBytes };
}
