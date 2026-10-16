import path from 'node:path';
import type { CheckResult } from '@shared/check';
import { type Project, SCREENSHOT_SIZES } from '@shared/project';
import type { ProjectAdapter, Shot, ShotTarget } from '../../services/ports';
import type { CommandRunner } from '../shared/commandRunner';
import { Mutex } from '../shared/mutex';
import type { DevServerManager, RunningServer } from './devServer';
import type { Screenshotter } from './screenshotter';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Web projects: checks from the project settings, then the dev server and headless Chrome for screenshots.
export class WebAdapter implements ProjectAdapter {
  // One capture at a time across all projects, so a project never screenshots another project's dev server.
  private readonly _captureLock = new Mutex();

  constructor(
    private readonly _commands: Pick<CommandRunner, 'runAll'>,
    private readonly _devServers: Pick<DevServerManager, 'ensure'>,
    private readonly _screenshotter: Pick<Screenshotter, 'capture'>,
    private readonly _screenshotsDir: string,
  ) {}

  check(project: Project, signal: AbortSignal): Promise<CheckResult[]> {
    return this._commands.runAll(project.repoPath, project.checkCommands, signal);
  }

  screenshots(project: Project, target: ShotTarget, signal: AbortSignal): Promise<Shot[]> {
    return this._captureLock.run(async () => {
      let server: RunningServer;
      try {
        server = await this._devServers.ensure(project, signal);
      } catch (err) {
        return this._failAll(project, target, message(err));
      }
      try {
        const relativeDir = `${target.taskId}/${target.runId}`;
        return await this._screenshotter.capture(
          {
            baseUrl: server.url,
            routes: target.routes,
            sizes: project.screenshotSizes,
            dir: path.join(this._screenshotsDir, relativeDir),
            relativeDir,
          },
          signal,
        );
      } finally {
        await server.stop();
      }
    });
  }

  private _failAll(project: Project, target: ShotTarget, error: string): Shot[] {
    return project.screenshotSizes.flatMap((size) =>
      target.routes.map((route) => ({ route, size, ...SCREENSHOT_SIZES[size], file: null, error })),
    );
  }
}
