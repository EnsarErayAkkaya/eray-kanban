import type { CheckResult } from '@shared/check';
import type { Project } from '@shared/project';
import type { ProjectAdapter } from '../../services/ports';
import type { CommandRunner } from '../shared/commandRunner';

// Any project: its check commands are plain shell-free commands; there is nothing to screenshot.
export class GenericAdapter implements ProjectAdapter {
  constructor(private readonly _commands: CommandRunner) {}

  check(project: Project, signal: AbortSignal): Promise<CheckResult[]> {
    return this._commands.runAll(project.repoPath, project.checkCommands, signal);
  }
}
