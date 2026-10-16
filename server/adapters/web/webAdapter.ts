import type { CheckResult } from '@shared/check';
import type { Project } from '@shared/project';
import type { ProjectAdapter } from '../../services/ports';
import type { CommandRunner } from '../shared/commandRunner';

// Web projects: checks from the project settings; the dev server and screenshots join in the next step.
export class WebAdapter implements ProjectAdapter {
  constructor(private readonly _commands: CommandRunner) {}

  check(project: Project, signal: AbortSignal): Promise<CheckResult[]> {
    return this._commands.runAll(project.repoPath, project.checkCommands, signal);
  }
}
