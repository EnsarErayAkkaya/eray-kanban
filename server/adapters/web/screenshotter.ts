import fs from 'node:fs';
import path from 'node:path';
import { type Browser, chromium } from 'playwright-core';
import { SCREENSHOT_SIZES, type ScreenshotSize } from '@shared/project';
import type { Shot } from '../../services/ports';

export interface ScreenshotterOptions {
  /** A Chrome install Playwright can find; 'chrome' is the stable Google Chrome. */
  readonly channel: string;
  readonly navigationTimeoutMs: number;
  /** How long to wait for the network to go quiet after load; pages that never settle are captured anyway. */
  readonly settleMs: number;
}

export const DEFAULT_SCREENSHOTTER_OPTIONS: ScreenshotterOptions = {
  channel: 'chrome',
  navigationTimeoutMs: 30_000,
  settleMs: 5_000,
};

export interface CaptureRequest {
  readonly baseUrl: string;
  readonly routes: readonly string[];
  readonly sizes: readonly ScreenshotSize[];
  /** Absolute folder for the PNGs. */
  readonly dir: string;
  /** Prefix of the stored file paths, relative to the screenshots folder. */
  readonly relativeDir: string;
}

// First line only, without Playwright's "page.goto:" prefix: "net::ERR_CONNECTION_REFUSED at http://…".
const message = (err: unknown) =>
  (err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)).replace(/^\w+\.\w+: /, '');

// '/settings/profile' → 'settings-profile'; the index keeps two routes that slug alike apart.
function fileName(index: number, route: string, size: ScreenshotSize): string {
  const slug = route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
  return `${index + 1}-${slug.slice(0, 60)}-${size}.png`;
}

export class Screenshotter {
  constructor(private readonly _options: ScreenshotterOptions = DEFAULT_SCREENSHOTTER_OPTIONS) {}

  /** One headless browser per call, always closed; a failing route becomes a shot with an error. */
  async capture(req: CaptureRequest, signal: AbortSignal): Promise<Shot[]> {
    const blank = (route: string, size: ScreenshotSize, error: string): Shot => ({
      route,
      size,
      ...SCREENSHOT_SIZES[size],
      file: null,
      error,
    });
    let browser: Browser;
    try {
      browser = await chromium.launch({ channel: this._options.channel, headless: true });
    } catch (err) {
      const why = `Could not start Chrome: ${message(err)}`;
      return req.sizes.flatMap((size) => req.routes.map((route) => blank(route, size, why)));
    }

    const onAbort = () => void browser.close().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    const shots: Shot[] = [];
    try {
      fs.mkdirSync(req.dir, { recursive: true });
      for (const size of req.sizes) {
        const viewport = SCREENSHOT_SIZES[size];
        const touch = size !== 'desktop';
        const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
        const page = await context.newPage();
        for (const [index, route] of req.routes.entries()) {
          if (signal.aborted) break;
          const name = fileName(index, route, size);
          try {
            const response = await page.goto(new URL(route, req.baseUrl).href, {
              waitUntil: 'load',
              timeout: this._options.navigationTimeoutMs,
            });
            await page.waitForLoadState('networkidle', { timeout: this._options.settleMs }).catch(() => undefined);
            await page.screenshot({ path: path.join(req.dir, name), fullPage: true });
            const status = response?.status() ?? 0;
            shots.push({
              route,
              size,
              ...viewport,
              file: `${req.relativeDir}/${name}`,
              error: status >= 400 ? `The page answered HTTP ${status}` : null,
            });
          } catch (err) {
            shots.push(blank(route, size, signal.aborted ? 'Stopped' : message(err)));
          }
        }
        await context.close().catch(() => undefined);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      await browser.close().catch(() => undefined);
    }
    return shots;
  }
}
