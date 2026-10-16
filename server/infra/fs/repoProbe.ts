import fs from 'node:fs';
import path from 'node:path';
import type { RepoProbe } from '../../services/ports';

export class FsRepoProbe implements RepoProbe {
  isGitRepo(dir: string): boolean {
    return path.isAbsolute(dir) && fs.existsSync(path.join(dir, '.git'));
  }
}
