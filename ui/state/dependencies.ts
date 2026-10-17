import type { Task } from '@shared/task';

function waitsOn(tasks: readonly Task[], candidate: Task, selfId: number): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<number>();
  for (let next = candidate.dependsOn; next !== null && !seen.has(next); next = byId.get(next)?.dependsOn ?? null) {
    if (next === selfId) return true;
    seen.add(next);
  }
  return false;
}

/** Tasks the form may offer as a dependency; the server checks the same rules. */
export function dependencyCandidates(tasks: readonly Task[], projectId: number, task?: Task): Task[] {
  // Done tasks are already satisfied and cancelled ones never would be; an edit keeps the one it has.
  // A task that already waits on this one would close a loop.
  return tasks.filter(
    (t) =>
      t.projectId === projectId &&
      t.id !== task?.id &&
      (t.id === task?.dependsOn || (t.status !== 'done' && t.status !== 'cancelled')) &&
      (task === undefined || !waitsOn(tasks, t, task.id)),
  );
}
