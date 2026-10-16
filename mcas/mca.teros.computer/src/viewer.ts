/**
 * Live view served by the computer itself, reachable only through the backend
 * proxy (SDK extension routes require the backend's bearer token):
 *
 *   GET  /viewer/                → viewer page (noVNC client + take-over bar)
 *   GET  /viewer/novnc/…         → noVNC ES modules (vendored in the image)
 *   GET  /viewer/control         → who holds control
 *   POST /viewer/control         → { action: 'take' | 'release' }; the backend
 *                                   passes the signed-in user in X-Teros-User-*
 *   WS   /viewer/vnc             → RFB over WebSocket ⇄ Xvnc's unix socket
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { ControlLease } from './control';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

export interface ViewerOptions {
  /** Directory with index.html / viewer.js / viewer.css. */
  staticDir: string;
  /** Directory containing noVNC's core/ and vendor/. */
  novncDir: string;
  /** Xvnc RFB unix socket. */
  vncSocket: string;
  control: ControlLease;
}

/** Resolve `rel` under `root`, or null if it escapes it. */
export function safeJoin(root: string, rel: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(rel);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes('\0')) return null;
  const full = resolve(root, normalize(`./${decoded}`));
  return full === resolve(root) || full.startsWith(`${resolve(root)}/`) ? full : null;
}

async function sendFile(res: ServerResponse, path: string | null): Promise<void> {
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': path.includes('/novnc/') ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createViewerHttpHandler(opts: ViewerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url || '/').split('?')[0];
    const rel = path.replace(/^\/viewer\/?/, '');

    if (rel === 'control') {
      if (req.method === 'GET') return json(res, 200, opts.control.get());
      if (req.method === 'POST') {
        const body = await readJson(req).catch(() => null);
        const userId = String(req.headers['x-teros-user-id'] || '');
        const name = req.headers['x-teros-user-name'];
        const displayName = name ? decodeURIComponent(String(name)) : undefined;
        if (body?.action === 'take') {
          if (!userId) return json(res, 400, { error: 'missing user' });
          return json(res, 200, await opts.control.takeOver(userId, displayName));
        }
        if (body?.action === 'release') return json(res, 200, await opts.control.handBack());
        return json(res, 400, { error: 'action must be take or release' });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (rel === '' || rel === 'index.html') return sendFile(res, join(opts.staticDir, 'index.html'));
    if (rel.startsWith('novnc/')) return sendFile(res, safeJoin(opts.novncDir, rel.slice('novnc/'.length)));
    return sendFile(res, safeJoin(opts.staticDir, rel));
  };
}

/**
 * WebSocket ⇄ Xvnc relay. Binary frames carry raw RFB; Xvnc sees one more VNC
 * client. Input is gated by Xvnc itself (ControlLease toggles Accept*Events).
 */
export function createVncRelay(vncSocket: string) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const vnc = createConnection(vncSocket);
      vnc.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });
      ws.on('message', (data) => {
        vnc.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
      });
      const close = () => {
        vnc.destroy();
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
      };
      vnc.on('error', close);
      vnc.on('close', close);
      ws.on('close', close);
      ws.on('error', close);
    });
  };
}
