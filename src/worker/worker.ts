/// <reference lib="webworker" />
import { ConversionError } from '../engine/contracts';
import { writeBatch } from '../engine/batch';
import { exportConversation, importArchive, listExports, writePackage } from '../engine/pipeline';
import { searchConversations, summarizeArchive, summarizeConversation } from '../engine/summary';
import { applyEdits, type Edits } from '../engine/transforms';
import type { Conversation, UniversalChat } from '../model';
import { sourceFromBlobs, sourceFromInputFile, type Source } from '../sources/index';
import type {
  BatchRequestMsg,
  ConversationMeta,
  ImportRequest,
  PackageDestination,
  PackageRequestMsg,
  WorkerRequest,
  WorkerResponse,
} from './types';

/**
 * Web Worker entry. Runs the engine off the main thread. An import keeps its archive (every conversation
 * of the export) and its file handles here, keyed by the import request id, so the page holds only the
 * conversation it shows and a later `package`/`batch` request can stream the media without the page ever
 * holding the bytes.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const sources = new Map<string, Source>();
const archives = new Map<string, UniversalChat>();
/** The conversation each import last opened. */
const opened = new Map<string, number>();
const running = new Map<string, AbortController>();

function conversationAt(importId: string | undefined, index: number | undefined): Conversation | undefined {
  if (!importId) return undefined;
  const archive = archives.get(importId);
  return archive?.conversations[index ?? opened.get(importId) ?? 0];
}

function resolveConversation(req: { conversation?: Conversation; importId?: string; conversationIndex?: number; edits?: Edits }): Conversation {
  const base = req.conversation ?? conversationAt(req.importId, req.conversationIndex);
  if (!base) throw new ConversionError('The imported conversation is no longer available; import it again', 'NO_SOURCE');
  return req.edits ? applyEdits(base, req.edits) : base;
}

function metaOf(conversation: Conversation): ConversationMeta {
  const meta: ConversationMeta = {
    kind: conversation.kind,
    messageCount: conversation.messages.length,
    participantCount: conversation.participants.length,
  };
  if (conversation.title) meta.title = conversation.title;
  return meta;
}

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

async function openRequestInput(req: ImportRequest): Promise<Source> {
  const input = req.input ?? (req.file ? { kind: 'bytes' as const, file: req.file } : undefined);
  if (!input) throw new ConversionError('Nothing to import', 'EMPTY_INPUT');
  if (input.kind === 'bytes') return sourceFromInputFile(input.file);
  // A single dropped zip is opened as an archive.
  const only = input.entries.length === 1 ? input.entries[0] : undefined;
  if (only && /\.zip$/i.test(only.path)) {
    return sourceFromInputFile({ name: only.path, bytes: new Uint8Array(await only.file.arrayBuffer()) });
  }
  return sourceFromBlobs(input.name, input.entries.map((e) => ({ path: e.path, blob: e.file })));
}

async function destinationStream(dest: PackageDestination): Promise<{ writable: WritableStream<Uint8Array>; opfsName?: string }> {
  if (dest.kind === 'port') {
    // Streamed download through download-sw.js: one chunk per 'pull' the service worker sends, so at most its
    // queue (8 chunks) is in flight. 'cancel' means the browser stopped receiving the file.
    const port = dest.port as unknown as MessagePort;
    let credits = 0;
    let stopped = '';
    let wake: (() => void) | undefined;
    port.onmessage = (e: MessageEvent<{ type?: string; reason?: string }>) => {
      if (e.data?.type === 'pull') credits += 1;
      else if (e.data?.type === 'cancel') stopped = e.data.reason || 'The download was cancelled.';
      wake?.();
    };
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        while (!credits && !stopped) await new Promise<void>((resolve) => (wake = resolve));
        if (stopped) throw new DOMException(stopped, 'AbortError');
        credits -= 1;
        const copy = chunk.slice();
        port.postMessage({ type: 'chunk', chunk: copy }, [copy.buffer]);
      },
      close() {
        port.postMessage({ type: 'end' });
      },
      abort(reason) {
        port.postMessage({ type: 'abort', reason: reason instanceof Error ? reason.message : String(reason ?? '') });
      },
    });
    return { writable };
  }
  if (dest.kind === 'handle') {
    const handle = dest.handle as unknown as FileSystemFileHandle;
    return { writable: (await handle.createWritable()) as WritableStream<Uint8Array> };
  }
  // OPFS through a sync access handle: available in workers in every current engine, including Safari.
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(dest.name, { create: true });
  const access = await fh.createSyncAccessHandle();
  access.truncate(0);
  let at = 0;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      at += access.write(chunk, { at });
    },
    close() {
      access.flush();
      access.close();
    },
    abort() {
      access.close();
    },
  });
  return { writable, opfsName: dest.name };
}

function sourceOf(importId: string): Source {
  const source = sources.get(importId);
  if (!source) throw new ConversionError('The imported files are no longer available; import them again', 'NO_SOURCE');
  return source;
}

async function runPackage(req: PackageRequestMsg): Promise<void> {
  const source = sourceOf(req.importId);
  const abort = new AbortController();
  running.set(req.id, abort);
  try {
    const { writable, opfsName } = await destinationStream(req.destination);
    const result = await writePackage(resolveConversation(req), {
      target: req.target,
      source,
      destination: writable,
      ...(req.exportOptions ? { exportOptions: req.exportOptions } : {}),
      signal: abort.signal,
      onProgress: (p) => post({ id: req.id, ok: true, action: 'progress', entries: p.entries, bytes: p.bytes }),
    });
    post({
      id: req.id,
      ok: true,
      action: 'package',
      summary: result.summary,
      report: result.report,
      warnings: result.warnings,
      archiveBytes: result.archiveBytes,
      ...(opfsName ? { opfsName } : {}),
    });
  } finally {
    running.delete(req.id);
  }
}

async function runBatch(req: BatchRequestMsg): Promise<void> {
  const source = sourceOf(req.importId);
  const archive = archives.get(req.importId);
  if (!archive) throw new ConversionError('The imported conversations are no longer available; import them again', 'NO_SOURCE');
  const items = req.items.map((it) => {
    const base = archive.conversations[it.index];
    if (!base) throw new ConversionError(`No conversation #${it.index} in this import`, 'NO_SOURCE');
    return { conversation: it.edits ? applyEdits(base, it.edits) : base, ...(it.exportOptions ? { exportOptions: it.exportOptions } : {}) };
  });
  const abort = new AbortController();
  running.set(req.id, abort);
  try {
    const { writable, opfsName } = await destinationStream(req.destination);
    const r = await writeBatch(items, {
      target: req.target,
      source,
      destination: writable,
      name: archive.source?.name ?? source.name,
      ...(archive.source ? { archiveSource: archive.source } : {}),
      signal: abort.signal,
      onProgress: (p) => post({ id: req.id, ok: true, action: 'progress', entries: p.entries, bytes: p.bytes }),
    });
    post({ id: req.id, ok: true, action: 'batch', ...r, ...(opfsName ? { opfsName } : {}) });
  } finally {
    running.delete(req.id);
  }
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>): Promise<void> => {
  const req = ev.data;
  try {
    switch (req.action) {
      case 'import': {
        const input = await openRequestInput(req);
        const found = await listExports(input);
        const exportIndex = Math.min(req.exportIndex ?? 0, Math.max(0, found.length - 1));
        const source = found[exportIndex] ?? input;
        const { archive, detectedPlatform, warnings } = await importArchive(source, {
          ...(req.source ? { source: req.source } : {}),
          ...(req.timeZone ? { timeZone: req.timeZone } : {}),
        });
        const first = archive.conversations[0];
        if (!first) throw new ConversionError('The export holds no conversation', 'EMPTY_EXPORT');
        sources.set(req.id, source);
        archives.set(req.id, archive);
        opened.set(req.id, 0);
        const conversations = archive.conversations.map((c, i) => summarizeConversation(c, i));
        post({
          id: req.id,
          ok: true,
          action: 'import',
          conversation: first,
          detectedPlatform,
          warnings,
          meta: metaOf(first),
          exports: found.map((s) => s.name),
          sourceName: source.name,
          archive: summarizeArchive(conversations, archive.source),
          conversations,
          index: 0,
        });
        break;
      }
      case 'open': {
        const conversation = conversationAt(req.importId, req.index);
        if (!conversation) throw new ConversionError(`No conversation #${req.index} in this import`, 'NO_SOURCE');
        opened.set(req.importId, req.index);
        post({ id: req.id, ok: true, action: 'open', index: req.index, conversation, meta: metaOf(conversation) });
        break;
      }
      case 'search': {
        const archive = archives.get(req.importId);
        const { hits, total } = archive ? searchConversations(archive.conversations, req.query, req.limit) : { hits: [], total: 0 };
        post({ id: req.id, ok: true, action: 'search', hits, total });
        break;
      }
      case 'export': {
        const source = req.importId ? sources.get(req.importId) : undefined;
        const { artifact, report, warnings } = await exportConversation(resolveConversation(req), {
          target: req.target,
          ...(req.exportOptions ? { exportOptions: req.exportOptions } : {}),
          ...(source ? { source } : {}),
        });
        post({ id: req.id, ok: true, action: 'export', artifact, report, warnings });
        break;
      }
      case 'package':
        await runPackage(req);
        break;
      case 'batch':
        await runBatch(req);
        break;
      case 'cancel':
        running.get(req.requestId)?.abort(new DOMException('Cancelled', 'AbortError'));
        post({ id: req.id, ok: true, action: 'cancel' });
        break;
      case 'release':
        sources.delete(req.importId);
        archives.delete(req.importId);
        opened.delete(req.importId);
        post({ id: req.id, ok: true, action: 'release' });
        break;
    }
  } catch (e) {
    post({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof ConversionError ? { code: e.code } : {}),
    });
  }
};
