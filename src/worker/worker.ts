/// <reference lib="webworker" />
import { ConversionError } from '../engine/contracts';
import { exportConversation, importConversation, listExports, writePackage } from '../engine/pipeline';
import { sourceFromBlobs, sourceFromInputFile, type Source } from '../sources/index';
import type {
  ConversationMeta,
  ImportRequest,
  PackageDestination,
  PackageRequestMsg,
  WorkerRequest,
  WorkerResponse,
} from './types';

/**
 * Web Worker entry. Runs the engine off the main thread. Imports keep their file handles here (keyed by
 * the import request id) so a later `package` request can stream the media without the page ever
 * holding the bytes.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const sources = new Map<string, Source>();
const running = new Map<string, AbortController>();

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

async function runPackage(req: PackageRequestMsg): Promise<void> {
  const source = sources.get(req.importId);
  if (!source) throw new ConversionError('The imported files are no longer available; import them again', 'NO_SOURCE');
  const abort = new AbortController();
  running.set(req.id, abort);
  try {
    const { writable, opfsName } = await destinationStream(req.destination);
    const result = await writePackage(req.conversation, {
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

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>): Promise<void> => {
  const req = ev.data;
  try {
    switch (req.action) {
      case 'import': {
        const opened = await openRequestInput(req);
        const found = await listExports(opened);
        const index = Math.min(req.exportIndex ?? 0, Math.max(0, found.length - 1));
        const source = found[index] ?? opened;
        const { conversation, detectedPlatform, warnings } = await importConversation(source, {
          ...(req.source ? { source: req.source } : {}),
          ...(req.timeZone ? { timeZone: req.timeZone } : {}),
        });
        sources.set(req.id, source);
        const meta: ConversationMeta = {
          kind: conversation.kind,
          messageCount: conversation.messages.length,
          participantCount: conversation.participants.length,
        };
        if (conversation.title) meta.title = conversation.title;
        post({
          id: req.id,
          ok: true,
          action: 'import',
          conversation,
          detectedPlatform,
          warnings,
          meta,
          exports: found.map((s) => s.name),
          sourceName: source.name,
        });
        break;
      }
      case 'export': {
        const { artifact, report, warnings } = await exportConversation(req.conversation, {
          target: req.target,
          ...(req.exportOptions ? { exportOptions: req.exportOptions } : {}),
        });
        post({ id: req.id, ok: true, action: 'export', artifact, report, warnings });
        break;
      }
      case 'package':
        await runPackage(req);
        break;
      case 'cancel':
        running.get(req.requestId)?.abort(new DOMException('Cancelled', 'AbortError'));
        post({ id: req.id, ok: true, action: 'cancel' });
        break;
      case 'release':
        sources.delete(req.importId);
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
