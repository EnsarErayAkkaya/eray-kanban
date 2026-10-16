import type { Task } from '@shared/task';

// {{#key}}...{{/key}} keeps its block only when key is non-empty; {{key}} is replaced in one pass,
// so task text that happens to contain {{...}} is never expanded.
export function renderPrompt(template: string, values: Readonly<Record<string, string>>): string {
  const value = (key: string) => (Object.hasOwn(values, key) ? values[key] : undefined);
  return template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g, (_, key: string, block: string) => (value(key) ? block : ''))
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => value(key) ?? match);
}

function taskValues(task: Task): Record<string, string> {
  return {
    id: String(task.id),
    title: task.title,
    description: task.description.trim(),
    acceptanceCriteria: task.acceptanceCriteria.trim(),
  };
}

export function renderTaskPrompt(template: string, task: Task): string {
  return renderPrompt(template, taskValues(task));
}

export function renderFeedbackPrompt(template: string, task: Task, feedback: string): string {
  return renderPrompt(template, { ...taskValues(task), feedback: feedback.trim() });
}
