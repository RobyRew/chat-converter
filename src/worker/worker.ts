/// <reference lib="webworker" />
import { exportConversation, importConversation } from '../engine/pipeline';
import type { ConversationMeta, WorkerRequest, WorkerResponse } from './types';

/**
 * Web Worker entry. Runs the engine off the main thread. Two actions: `import` (parse a file
 * into the canonical model) and `export` (serialize a — possibly edited — conversation). The
 * edit step happens on the main thread between the two. In Node the engine is used directly.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>): Promise<void> => {
  const req = ev.data;
  try {
    if (req.action === 'import') {
      const { conversation, detectedPlatform, warnings } = await importConversation(req.file, { source: req.source });
      const meta: ConversationMeta = {
        kind: conversation.kind,
        messageCount: conversation.messages.length,
        participantCount: conversation.participants.length,
      };
      if (conversation.title) meta.title = conversation.title;
      ctx.postMessage({
        id: req.id,
        ok: true,
        action: 'import',
        conversation,
        detectedPlatform,
        warnings,
        meta,
      } satisfies WorkerResponse);
    } else {
      const { artifact, report, warnings } = await exportConversation(req.conversation, {
        target: req.target,
        exportOptions: req.exportOptions,
      });
      ctx.postMessage({ id: req.id, ok: true, action: 'export', artifact, report, warnings } satisfies WorkerResponse);
    }
  } catch (e) {
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies WorkerResponse);
  }
};
