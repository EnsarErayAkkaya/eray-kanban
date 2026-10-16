import type { Task } from '@shared/task';

type PromptValues = Record<'id' | 'title' | 'description' | 'acceptanceCriteria', string>;

// {{#key}}...{{/key}} keeps its block only when key is non-empty; {{key}} is replaced in one pass,
// so task text that happens to contain {{...}} is never expanded.
export function renderTaskPrompt(template: string, task: Task): string {
  const values: PromptValues = {
    id: String(task.id),
    title: task.title,
    description: task.description.trim(),
    acceptanceCriteria: task.acceptanceCriteria.trim(),
  };
  const isKey = (k: string): k is keyof PromptValues => k in values;

  return template
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g, (_, key: string, block: string) =>
      isKey(key) && values[key] ? block : '',
    )
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => (isKey(key) ? values[key] : match));
}
