import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor } from './processSupervisor';
import { resolveCommand, windowsLaunch } from './windowsCommand';
import { WindowsProcessPlatform } from './windowsProcessPlatform';

const files = (...names: string[]) => (file: string) => names.includes(file);
const env = { Path: 'C:\\tools;"C:\\Program Files\\nodejs"', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

describe('resolveCommand', () => {
  it('finds a bare name on PATH with PATHEXT, whatever the case of the variable names', () => {
    expect(resolveCommand('npm', env, 'C:\\repo', files('C:\\Program Files\\nodejs\\npm.cmd'))).toBe(
      'C:\\Program Files\\nodejs\\npm.cmd',
    );
    expect(resolveCommand('git', env, 'C:\\repo', files('C:\\tools\\git.exe', 'C:\\tools\\git.cmd'))).toBe('C:\\tools\\git.exe');
  });

  it('never looks in the project folder for a bare name', () => {
    expect(resolveCommand('npm', env, 'C:\\repo', files('C:\\repo\\npm.cmd'))).toBeNull();
  });

  it('resolves a relative path against the working directory', () => {
    const vitest = 'C:\\repo\\node_modules\\.bin\\vitest.cmd';
    expect(resolveCommand('node_modules/.bin/vitest', env, 'C:\\repo', files(vitest))).toBe(vitest);
  });

  it('keeps an explicit extension', () => {
    expect(resolveCommand('C:\\tools\\claude.exe', env, 'C:\\repo', files('C:\\tools\\claude.exe'))).toBe('C:\\tools\\claude.exe');
  });
});

describe('windowsLaunch', () => {
  it('starts an .exe directly and leaves the quoting to Node', () => {
    expect(windowsLaunch('git', ['status', 'a b'], env, 'C:\\repo', files('C:\\tools\\git.exe'))).toEqual({
      file: 'C:\\tools\\git.exe',
      args: ['status', 'a b'],
      verbatim: false,
    });
  });

  it('runs a .cmd through cmd.exe with escaped arguments', () => {
    const launch = windowsLaunch('npm', ['run', 'a&b'], { ...env, ComSpec: 'C:\\Windows\\cmd.exe' }, 'C:\\repo', files('C:\\tools\\npm.cmd'));
    expect(launch.file).toBe('C:\\Windows\\cmd.exe');
    expect(launch.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
    expect(launch.args[4]).not.toMatch(/[^^]&/);
    expect(launch.verbatim).toBe(true);
  });
});

// The real thing: a batch shim like npm's, in a folder whose name cmd.exe would otherwise misread.
describe.runIf(process.platform === 'win32')('a .cmd shim on Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-cmd a&b (x) '));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'echo.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(dir, 'echo.cmd'), `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo.js" %*\r\n`);

  it('passes every argument through unchanged', async () => {
    const args = [
      '-p',
      'Bash(npm test:*)',
      'Read(**/.env*)',
      'C:\\a b&c (x)\\CLAUDE.md',
      '100%',
      '%PATH%',
      'say "hi"',
      '^caret!',
      'back\\',
      'a|b>c<d',
      '',
    ];
    const exit = await new ProcessSupervisor(200, new WindowsProcessPlatform()).capture({
      command: path.join(dir, 'echo'),
      args,
      cwd: dir,
      env: process.env,
      stdin: '',
      timeoutMs: 10_000,
      maxStdoutBytes: 10_000,
    });
    expect(exit.stderrTail).toBe('');
    expect(JSON.parse(exit.stdout.toString())).toEqual(args);
  });
});
