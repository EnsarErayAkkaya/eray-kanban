import path from 'node:path';

export interface WindowsLaunch {
  readonly file: string;
  readonly args: readonly string[];
  /** True when args are already a cmd.exe command line that Node must not quote again. */
  readonly verbatim: boolean;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Node cannot start a .cmd or .bat (npm, npx, an npm-installed claude) without cmd.exe,
 * so those go through `cmd.exe /d /s /c` with every argument quoted and caret-escaped.
 */
export function windowsLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  isFile: (file: string) => boolean,
): WindowsLaunch {
  // Not found: spawn the name as given and let it report ENOENT.
  const resolved = resolveCommand(command, env, cwd, isFile) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args, verbatim: false };

  // The batch file re-parses its arguments when it expands %*, so they need a second round of carets.
  const line = [escapeArg(resolved, false), ...args.map((arg) => escapeArg(arg, true))].join(' ');
  return { file: envValue(env, 'ComSpec') ?? 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true };
}

/** Bare names are searched on PATH only, never in the project folder, so a repo cannot plant its own npm.cmd. */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  isFile: (file: string) => boolean,
): string | null {
  const exts = (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir
    ? [path.win32.resolve(cwd, command)]
    : (envValue(env, 'PATH') ?? '')
        .split(';')
        .map((dir) => dir.replace(/^"(.*)"$/, '$1'))
        .filter(Boolean)
        .map((dir) => path.win32.join(dir, command));
  const hasExt = exts.some((ext) => command.toLowerCase().endsWith(ext));
  for (const base of dirs) {
    if (hasExt && isFile(base)) return base;
    for (const ext of exts) if (isFile(base + ext)) return base + ext;
  }
  return null;
}

// Quote by the MSVCRT rules first, then escape for cmd.exe, as cross-spawn does.
function escapeArg(arg: string, twice: boolean): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  const once = quoted.replace(CMD_META, '^$1');
  return twice ? once.replace(CMD_META, '^$1') : once;
}

// Windows environment names are case-insensitive, but a copied env object keeps one spelling (Path, PATH).
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}
