import fs from 'node:fs';
import path from 'node:path';
import type { ScreenshotFiles } from '../../services/ports';

export class FsScreenshotFiles implements ScreenshotFiles {
  private readonly _root: string;

  constructor(root: string) {
    this._root = path.resolve(root);
  }

  read(file: string): Buffer | null {
    const abs = path.resolve(this._root, file);
    // Stored paths come from the screenshotter, but never let one escape the folder.
    if (!abs.startsWith(this._root + path.sep) || !abs.endsWith('.png')) return null;
    try {
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  }
}
