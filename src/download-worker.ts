/**
 * Download worker (worker_threads). Moves the bytes of one download attempt —
 * TLS, the response stream, the .part writes and inline zip extraction — off
 * the Electron main thread. In the main process every socket and file event
 * is marshalled into Chromium's message loop, and that capped a 10 GbE
 * download at ~270 MB/s with the main thread busy; here (together with
 * pump.ts's double-buffered writer) it measured ~490 MB/s — the server and
 * disk limit — and the UI stays free.
 *
 * Protocol (downloads.ts is the other side, see WorkerTransfer):
 *   main → { type: 'open', url, headers }   worker → { type: 'head', status, statusText, headers }
 *   main → { type: 'pump', opts }           worker → { type: 'progress', downloaded, inlineExtract }*
 *                                           worker → { type: 'done', result }
 *   main → { type: 'abort' }                (cancel, stall, or the response isn't wanted)
 *   worker → { type: 'stalled' }            no data for opts.stallMs; main decides and aborts
 *   worker → { type: 'error', message }     for open or pump
 */
import { parentPort } from 'worker_threads';
import { pumpToFile, PumpOptions } from './pump';

const port = parentPort!;
const controller = new AbortController();
let response: Response | null = null;

port.on('message', async (msg: { type: string; url?: string; headers?: Record<string, string>; opts?: PumpOptions }) => {
  if (msg.type === 'abort') {
    controller.abort();
    return;
  }
  try {
    if (msg.type === 'open') {
      response = await fetch(msg.url!, { headers: msg.headers, signal: controller.signal });
      port.postMessage({ type: 'head', status: response.status, statusText: response.statusText, headers: [...response.headers] });
    } else if (msg.type === 'pump') {
      if (!response?.body) throw new Error('Download failed: no response body');
      const result = await pumpToFile(response.body, msg.opts!, {
        onProgress: (downloaded, inlineExtract) => port.postMessage({ type: 'progress', downloaded, inlineExtract }),
        onStall: () => port.postMessage({ type: 'stalled' }),
      });
      port.postMessage({ type: 'done', result });
    }
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});
