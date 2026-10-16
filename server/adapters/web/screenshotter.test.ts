import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Screenshotter } from './screenshotter';

// Integration test against the installed Google Chrome (the choice for this project); skipped where there is none.
const hasChrome = fs.existsSync('/Applications/Google Chrome.app');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-shots-'));
let server: http.Server;
let baseUrl = '';

const pngWidth = (file: string) => fs.readFileSync(file).readUInt32BE(16);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // Without the viewport tag a phone lays the page out 980px wide, and so does the emulation.
    const head = '<!doctype html><meta name="viewport" content="width=device-width">';
    if (req.url === '/') return res.end(`${head}<title>Home</title><h1>Hello screenshots</h1>`);
    res.statusCode = 404;
    res.end('<h1>Not here</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasChrome)('Screenshotter (installed Chrome)', () => {
  const shooter = new Screenshotter({ channel: 'chrome', navigationTimeoutMs: 10_000, settleMs: 500 });
  const never = new AbortController().signal;

  it('captures every route at every size, and notes an HTTP error', async () => {
    const shots = await shooter.capture(
      { baseUrl, routes: ['/', '/missing'], sizes: ['desktop', 'mobile'], dir: path.join(dir, '1/2'), relativeDir: '1/2' },
      never,
    );
    expect(shots.map((s) => [s.route, s.size, s.file, s.error])).toEqual([
      ['/', 'desktop', '1/2/1-root-desktop.png', null],
      ['/missing', 'desktop', '1/2/2-missing-desktop.png', 'The page answered HTTP 404'],
      ['/', 'mobile', '1/2/1-root-mobile.png', null],
      ['/missing', 'mobile', '1/2/2-missing-mobile.png', 'The page answered HTTP 404'],
    ]);
    expect(pngWidth(path.join(dir, '1/2/1-root-desktop.png'))).toBe(1280);
    expect(pngWidth(path.join(dir, '1/2/1-root-mobile.png'))).toBe(390);
  }, 60_000);

  it('records a route that cannot load as an error, without a file', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));

    const shots = await shooter.capture(
      { baseUrl: `http://127.0.0.1:${port}`, routes: ['/'], sizes: ['desktop'], dir: path.join(dir, 'x'), relativeDir: 'x' },
      never,
    );
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ file: null, error: expect.stringMatching(/^net::ERR_CONNECTION_REFUSED/) });
  }, 60_000);
});

describe('Screenshotter without a usable browser', () => {
  it('turns a launch failure into an error per shot', async () => {
    const shooter = new Screenshotter({ channel: 'no-such-browser', navigationTimeoutMs: 1_000, settleMs: 100 });
    const shots = await shooter.capture(
      { baseUrl, routes: ['/', '/a'], sizes: ['desktop'], dir: path.join(dir, 'y'), relativeDir: 'y' },
      new AbortController().signal,
    );
    expect(shots.map((s) => s.file)).toEqual([null, null]);
    expect(shots[0]?.error).toMatch(/^Could not start Chrome/);
  });
});
