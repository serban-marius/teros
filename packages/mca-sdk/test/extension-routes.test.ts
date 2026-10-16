/**
 * Test — extension routes (httpRoute / wsRoute) on McaHttpServer.
 *
 * MCA container ports are published on the host, so anything an MCA serves
 * beyond the tool protocol (e.g. mca.teros.computer's live view) must only be
 * reachable by the backend: requests need `Authorization: Bearer
 * <MCA_CALLBACK_TOKEN>`, and the check fails closed when no token is set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type IncomingMessage, request } from 'http';
import { PassThrough } from 'stream';
import { McaHttpServer } from '../src/http-server';

const TOKEN = 'test-callback-token';
const PORT = 18000 + Math.floor(Math.random() * 1000);
let server: McaHttpServer;
const originalToken = process.env.MCA_CALLBACK_TOKEN;

function get(path: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Drive the upgrade dispatcher directly: Bun's node:http does not hand raw
 * upgrade sockets to 'upgrade' listeners (Node, which runs the containers, does).
 */
function upgrade(path: string, token?: string): string {
  const socket = new PassThrough();
  let written = '';
  socket.on('data', (d) => {
    written += d.toString();
  });
  const req = {
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
  (server as unknown as { handleUpgrade: (r: IncomingMessage, s: PassThrough, h: Buffer) => void })
    .handleUpgrade(req, socket, Buffer.alloc(0));
  return written.split('\r\n')[0];
}

beforeAll(async () => {
  process.env.MCA_CALLBACK_TOKEN = TOKEN;
  server = new McaHttpServer({ id: 'mca.test.ext', name: 'Ext', version: '1.0.0', port: PORT, host: '127.0.0.1' });
  server.httpRoute('/viewer', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`viewer:${req.url}`);
  });
  server.wsRoute('/viewer/ws', (_req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  process.env.MCA_CALLBACK_TOKEN = originalToken;
});

describe('McaHttpServer extension routes', () => {
  it('serves a registered route to the backend token', async () => {
    const res = await get('/viewer/index.html', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toBe('viewer:/viewer/index.html');
  });

  it('rejects requests without or with a wrong token', async () => {
    expect((await get('/viewer/index.html')).status).toBe(401);
    expect((await get('/viewer/index.html', 'nope')).status).toBe(401);
  });

  it('does not treat a longer path as the prefix', async () => {
    expect((await get('/viewerx', TOKEN)).status).toBe(404);
  });

  it('keeps the tool protocol routes untouched', async () => {
    expect((await get('/health')).status).toBe(200);
  });

  it('accepts authorized upgrades and refuses the rest', () => {
    expect(upgrade('/viewer/ws', TOKEN)).toBe('HTTP/1.1 101 Switching Protocols');
    expect(upgrade('/viewer/ws')).toBe('HTTP/1.1 401 Unauthorized');
    expect(upgrade('/other', TOKEN)).toBe('HTTP/1.1 404 Not Found');
  });

  it('fails closed when no callback token is configured', async () => {
    delete process.env.MCA_CALLBACK_TOKEN;
    try {
      expect((await get('/viewer/index.html', TOKEN)).status).toBe(401);
    } finally {
      process.env.MCA_CALLBACK_TOKEN = TOKEN;
    }
  });
});
