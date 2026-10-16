import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_SHORTCUT_SCRIPT, desktopEntry, posixLauncher, rotateLog, uiIsStale } from './launchers';

describe('uiIsStale', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const repo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-repo-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'ui', 'components'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ui', 'components', 'App.tsx'), 'x');
    return dir;
  };
  const build = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'dist', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'ui', 'index.html'), 'x');
  };
  const touch = (file: string, secondsFromNow: number) => {
    const at = new Date(Date.now() + secondsFromNow * 1000);
    fs.utimesSync(file, at, at);
  };

  it('is stale with no build, fresh after one, and stale again when a nested UI file changes', () => {
    const dir = repo();
    expect(uiIsStale(dir)).toBe(true);
    build(dir);
    touch(path.join(dir, 'ui', 'components', 'App.tsx'), -60);
    touch(path.join(dir, 'ui', 'components'), -60);
    touch(path.join(dir, 'ui'), -60);
    expect(uiIsStale(dir)).toBe(false);
    touch(path.join(dir, 'ui', 'components', 'App.tsx'), 60);
    expect(uiIsStale(dir)).toBe(true);
  });
});

describe('posixLauncher', () => {
  it('quotes the repo path so spaces and quotes in it cannot break the script', () => {
    const script = posixLauncher("/home/me/my repos/it's here", 'terminal');
    expect(script.startsWith('#!/bin/bash\n')).toBe(true);
    expect(script).toContain(`cd '/home/me/my repos/it'\\''s here' || exit 1`);
    expect(script).toContain('npm start');
  });
});

describe('posixLauncher in the background', () => {
  it('starts detached and says so when it fails, since there is no terminal to read', () => {
    expect(posixLauncher('/repo', 'background')).toContain('npm start -- --background || notify-send');
  });
});

describe('desktopEntry', () => {
  it('runs the launcher without a terminal, with Exec quoted by the desktop-entry rules', () => {
    const entry = desktopEntry('/home/me/.local/share/agent-kanban/start "$x".sh');
    expect(entry).toContain('Exec="/home/me/.local/share/agent-kanban/start \\"\\$x\\".sh"');
    expect(entry).toContain('Terminal=false');
  });
});

describe('WINDOWS_SHORTCUT_SCRIPT', () => {
  it('starts the hidden tray app, with every path taken from the environment', () => {
    expect(WINDOWS_SHORTCUT_SCRIPT).toContain('$env:KANBAN_REPO');
    expect(WINDOWS_SHORTCUT_SCRIPT).toContain('-WindowStyle Hidden -File `"$env:KANBAN_TRAY`"');
    expect(WINDOWS_SHORTCUT_SCRIPT).toContain('$env:KANBAN_ICON');
    expect(WINDOWS_SHORTCUT_SCRIPT).toContain("GetFolderPath('Desktop')");
  });
});

describe('rotateLog', () => {
  it('keeps one previous log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-log-'));
    const log = rotateLog(dir);
    fs.writeFileSync(log, 'first run');
    expect(rotateLog(dir)).toBe(log);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'server.old.log'), 'utf8')).toBe('first run');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
