import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serves the built UI, so one process on one port is the whole app. Never serves anything outside root. */
export function registerStaticUi(app: FastifyInstance, root: string): void {
  const base = path.resolve(root);
  const index = path.join(base, 'index.html');

  app.get('/*', async (req, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      return reply.code(400).send({ error: 'Bad path' });
    }
    if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });

    const file = path.resolve(base, `.${pathname}`);
    if (file !== base && !file.startsWith(base + path.sep)) return reply.code(404).send({ error: 'Not found' });
    // A missing file with an extension is a real 404; anything else is a page the UI routes itself.
    const target = isFile(file) ? file : path.extname(pathname) === '' ? index : null;
    if (target === null || !isFile(target)) return reply.code(404).send({ error: 'Not found' });

    // Vite fingerprints everything under assets/, so those never change; index.html must always be fresh.
    const immutable = target !== index && pathname.startsWith('/assets/');
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    reply.type(TYPES[path.extname(target)] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(target));
  });
}

function isFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}
