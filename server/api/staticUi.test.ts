import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerStaticUi } from './staticUi';

describe('registerStaticUi', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-ui-'));
  const root = path.join(tmp, 'ui');
  let app: FastifyInstance;

  beforeAll(() => {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>board</title>');
    fs.writeFileSync(path.join(root, 'assets', 'app-1a2b.js'), 'console.log(1)');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the ui folder');
    app = Fastify();
    app.get('/api/health', async () => ({ ok: true }));
    registerStaticUi(app, root);
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it('serves index.html at the root and for UI routes, never cached', async () => {
    for (const url of ['/', '/settings', '/tasks/12?tab=log']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<title>board</title>');
    }
  });

  it('serves fingerprinted assets with a long cache', async () => {
    const res = await get('/assets/app-1a2b.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('answers 404 for a missing file and for unknown API paths, instead of the page', async () => {
    expect((await get('/assets/gone.js')).statusCode).toBe(404);
    expect((await get('/api/nope')).statusCode).toBe(404);
    expect((await get('/api/health')).json()).toEqual({ ok: true });
  });

  it('never serves anything outside its folder', async () => {
    for (const url of ['/../secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt']) {
      const res = await get(url);
      expect(res.body).not.toContain('outside the ui folder');
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  it('rejects a malformed path', async () => {
    expect((await get('/%E0%A4%A')).statusCode).toBe(400);
  });
});
