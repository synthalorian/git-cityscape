import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveHistory } from '../src/cli/serve';

describe('serveHistory', () => {
  let base: string;
  let close: () => void;
  let origin: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'cityscape-serve-'));
    const root = join(base, 'web');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<html></html>');
    writeFileSync(join(root, 'assets', 'app.js'), 'ok');
    writeFileSync(join(base, 'secret.txt'), 'top secret');
    symlinkSync(join(base, 'secret.txt'), join(root, 'secret'));
    symlinkSync(base, join(root, 'up'));
    symlinkSync(join(root, 'assets', 'app.js'), join(root, 'inside.js'));
    const { server } = await serveHistory({ version: 1, repo: 'r', generatedAt: '', authors: [], files: [], commits: [] }, { port: 0, webRoot: root });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  afterAll(() => {
    close?.();
    rmSync(base, { recursive: true, force: true });
  });

  it('serves files and history', async () => {
    expect(await (await fetch(`${origin}/assets/app.js`)).text()).toBe('ok');
    expect(await (await fetch(`${origin}/inside.js`)).text()).toBe('ok');
    expect((await (await fetch(`${origin}/history.json`)).json()).repo).toBe('r');
  });

  it('refuses symlinks that resolve outside the web root', async () => {
    for (const path of ['/secret', '/up/secret.txt']) {
      const res = await fetch(`${origin}${path}`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('top secret');
    }
    expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
  });
});
