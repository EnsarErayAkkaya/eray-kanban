export class NotFoundError extends Error {
  constructor(
    readonly entity: 'project' | 'task' | 'run',
    readonly id: number,
  ) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// The stored status moved on since the change was planned, e.g. a cancel raced the scheduler.
export class StaleStatusError extends Error {
  constructor(
    readonly taskId: number,
    readonly expected: string,
  ) {
    super(`Task ${taskId} is no longer ${expected}`);
    this.name = 'StaleStatusError';
  }
}

// A git command failed in a way the caller did not plan for (the expected ones come back as results).
export class GitError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(`git ${command} failed: ${detail}`);
    this.name = 'GitError';
  }
}

export class ProjectBusyError extends Error {
  constructor(readonly projectId: number) {
    super(`Project ${projectId} already has an active task`);
    this.name = 'ProjectBusyError';
  }
}
