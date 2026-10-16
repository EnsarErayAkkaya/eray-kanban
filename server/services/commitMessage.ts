import type { Task } from '@shared/task';

// The project's format fills the subject line; the agent's summary, when there is one, becomes the body.
export function commitMessage(format: string, task: Task, summary: string | null): string {
  const subject = format
    .replace(/\{(id|title)\}/g, (_, key: string) => (key === 'id' ? String(task.id) : task.title))
    .replace(/\s+/g, ' ')
    .trim();
  const body = summary?.trim();
  return body ? `${subject}\n\n${body}\n` : `${subject}\n`;
}
