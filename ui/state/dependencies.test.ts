import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/task';
import { dependencyCandidates } from './dependencies';

const task = (id: number, dependsOn: number | null = null, status: Task['status'] = 'backlog', projectId = 1): Task => ({
  id,
  projectId,
  title: `Task ${id}`,
  description: '',
  acceptanceCriteria: '',
  priority: 'normal',
  visual: false,
  routes: [],
  model: 'sonnet',
  turnLimit: 30,
  dependsOn,
  status,
  position: id,
  gitIssue: null,
  gitIssueDetail: null,
  pendingPush: null,
  commitSha: null,
  createdAt: '2026-10-17T09:00:00.000Z',
  updatedAt: '2026-10-17T09:00:00.000Z',
});

const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id);

describe('dependencyCandidates', () => {
  it('offers open tasks of the same project for a new task', () => {
    const tasks = [task(1), task(2, null, 'done'), task(3, null, 'cancelled'), task(4, null, 'todo', 2), task(5, null, 'in_review')];
    expect(ids(dependencyCandidates(tasks, 1))).toEqual([1, 5]);
  });

  it('leaves out the task itself and every task that already waits on it', () => {
    const tasks = [task(1), task(2, 1), task(3, 2), task(4)];
    expect(ids(dependencyCandidates(tasks, 1, tasks[0]))).toEqual([4]);
  });

  it('keeps the current dependency even when it is finished', () => {
    const tasks = [task(1, null, 'done'), task(2, 1)];
    expect(ids(dependencyCandidates(tasks, 1, tasks[1]))).toEqual([1]);
  });
});
