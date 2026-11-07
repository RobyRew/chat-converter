import type { WorkerRequest, WorkerResponse } from '../worker/types';

type Pending = {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (entries: number, bytes: number) => void;
};

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;
export type WorkerCall = Distribute<WorkerRequest>;

/** Request/response over the conversion Web Worker, with progress callbacks for packages. */
export class ConverterClient {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      if (res.ok && res.action === 'progress') {
        p.onProgress?.(res.entries, res.bytes);
        return;
      }
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res);
      else p.reject(Object.assign(new Error(res.error), { code: res.code }));
    };
    // A crashed worker (e.g. out of memory) must not leave the page waiting forever.
    worker.onerror = (ev) => {
      ev.preventDefault();
      const error = new Error(ev.message || 'The conversion worker stopped unexpectedly');
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  nextId(): string {
    this.seq += 1;
    return `r${this.seq}`;
  }

  call(req: WorkerCall, onProgress?: (entries: number, bytes: number) => void, id = this.nextId()): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** The bundled worker. Bundlers (Vite) resolve this URL when they process the package source. */
export function defaultWorker(): Worker {
  return new Worker(new URL('../worker/worker.ts', import.meta.url), { type: 'module', name: 'chat-converter' });
}
