import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { History } from '../core/types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Location of the built web app (dist/web), relative to the compiled CLI (dist/node/cli). */
export function defaultWebRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
}

export interface ServeOptions {
  port?: number;
  host?: string;
  webRoot?: string;
}

export async function serveHistory(history: History, opts: ServeOptions = {}): Promise<{ server: Server; url: string }> {
  const given = resolve(opts.webRoot ?? defaultWebRoot());
  if (!existsSync(join(given, 'index.html'))) {
    throw new Error(`Web app not found in ${given}. Run \`npm run build\` first.`);
  }
  // Containment is checked on canonical paths so symlinks cannot point outside the root.
  const root = await realpath(given);
  const inside = (p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  const json = Buffer.from(JSON.stringify(history));
  const gz = gzipSync(json);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/history.json') {
        const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        res.writeHead(200, {
          'content-type': MIME['.json'],
          'cache-control': 'no-store',
          ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(acceptsGzip ? gz : json);
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const requested = normalize(join(root, rel));
      if (!inside(requested)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const file = await realpath(requested).catch(() => null);
      if (file && !inside(file)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const info = file ? await stat(file).catch(() => null) : null;
      if (!info?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file!)] ?? 'application/octet-stream' });
      res.end(await readFile(file!));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    }
  });

  const port = opts.port ?? 4173;
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok());
  });
  const shownHost = host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host;
  return { server, url: `http://${shownHost}:${port}/?data=history.json` };
}

export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // ignore: the URL is printed anyway
  }
}
