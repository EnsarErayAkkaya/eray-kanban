import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm run skill`: copies the kanban skill into your Claude Code skills, so every repo can use it. Safe to run again.
const source = path.resolve(fileURLToPath(new URL('../skills/kanban', import.meta.url)));
const target = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'skills', 'kanban');
const FILES = ['SKILL.md', 'kanban.ts'];

fs.mkdirSync(target, { recursive: true });
for (const file of FILES) fs.copyFileSync(path.join(source, file), path.join(target, file));
console.log(`Installed the kanban skill in ${target}`);
console.log('In Claude Code, ask to "put these tasks on the board" or type /kanban.');
