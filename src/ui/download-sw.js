/*
 * Chat Converter download worker — a service worker, classic script, no imports.
 *
 * Browsers without a save dialog (Safari 15.4+, Firefox) receive packages through here. The page registers a
 * download id with two MessagePorts (data, control) and points a hidden frame at <scope>cc-download/<id>/<name>.
 * This worker answers that navigation with a streamed `Content-Disposition: attachment` response whose bytes the
 * converter's Web Worker writes into the data port, one chunk per `pull`. The file goes into the browser's
 * downloads as it is written; nothing is held in memory or in site storage. Counterpart:
 * startStreamedDownload() in src/browser/index.ts.
 *
 * Protocol
 *   page -> this worker (message event): { type: 'cc-download', id, name } with ports [data, control];
 *                                        { type: 'cc-keepalive' } every 10 s while a download runs.
 *   this worker -> data port:            { type: 'pull' } = send one more chunk; { type: 'cancel', reason }.
 *   data port -> this worker:            { type: 'chunk', chunk: Uint8Array } | { type: 'end' }
 *                                        | { type: 'abort', reason }.
 *   this worker -> control port:         { type: 'started' } | { type: 'closed' } | { type: 'cancelled', reason }.
 *
 * Size: this file is kept above 4096 bytes, Vite's default assetsInlineLimit. A smaller file is inlined as a
 * data: URL, and a service worker cannot be registered from one; test/download-sw.test.ts checks the size and
 * startStreamedDownload() falls back to browser storage when it finds a data: URL.
 */
'use strict';

const MARKER = '/cc-download/';
/** id -> { data: MessagePort, control: MessagePort, name: string } */
const pending = new Map();
/** id -> wake(), for a navigation that arrives before its registration message */
const waiters = new Map();

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('message', (event) => {
  const msg = event.data;
  // 'cc-keepalive' needs no reply: receiving it keeps this worker running during a long download.
  if (!msg || msg.type !== 'cc-download' || event.ports.length < 2) return;
  pending.set(msg.id, { data: event.ports[0], control: event.ports[1], name: String(msg.name || 'download.zip') });
  const wake = waiters.get(msg.id);
  if (wake) wake();
});

function entryFor(id) {
  if (pending.has(id)) return Promise.resolve(pending.get(id));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      resolve(undefined);
    }, 3000);
    waiters.set(id, () => {
      clearTimeout(timer);
      waiters.delete(id);
      resolve(pending.get(id));
    });
  });
}

function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function respond(id) {
  const entry = await entryFor(id);
  if (!entry) {
    return new Response('This download is no longer available.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  pending.delete(id);
  const { data, control, name } = entry;
  const body = new ReadableStream(
    {
      start(controller) {
        data.onmessage = (e) => {
          const m = e.data;
          if (!m) return;
          if (m.type === 'chunk') {
            controller.enqueue(m.chunk);
          } else if (m.type === 'end') {
            controller.close();
            control.postMessage({ type: 'closed' });
          } else if (m.type === 'abort') {
            controller.error(new Error(m.reason || 'The conversion stopped'));
            control.postMessage({ type: 'cancelled', reason: m.reason || '' });
          }
        };
        control.postMessage({ type: 'started' });
      },
      pull() {
        data.postMessage({ type: 'pull' });
      },
      cancel(reason) {
        data.postMessage({ type: 'cancel', reason: String(reason || '') });
        control.postMessage({ type: 'cancelled', reason: String(reason || '') });
      },
    },
    { highWaterMark: 8 },
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': disposition(name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const at = url.pathname.indexOf(MARKER);
  if (at === -1) return;
  const id = url.pathname.slice(at + MARKER.length).split('/')[0];
  event.respondWith(respond(id));
});
