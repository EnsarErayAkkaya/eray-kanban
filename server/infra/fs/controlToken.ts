import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_TOKEN_FILE } from '@shared/control';

/** A fresh token per start, readable only by you, so a web page can never stop the server. */
export function writeControlToken(dataDir: string): { readonly token: string; readonly remove: () => void } {
  const file = path.join(dataDir, CONTROL_TOKEN_FILE);
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return {
    token,
    remove: () => {
      // Only our own token: a newer server may have replaced it.
      try {
        if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true });
      } catch {
        // Already gone.
      }
    },
  };
}
