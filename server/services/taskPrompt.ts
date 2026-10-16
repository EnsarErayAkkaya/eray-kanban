import type { CheckResult } from '@shared/check';
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

const FAILURE_OUTPUT_LIMIT = 4_000;

function describeExit(check: CheckResult): string {
  if (check.timedOut) return 'timed out';
  return check.exitCode === null ? 'did not finish' : `exit ${check.exitCode}`;
}

// Only the end of each failing check's output: enough to find the error, without filling the context.
export function renderCheckFixPrompt(template: string, task: Task, failed: readonly CheckResult[]): string {
  const failures = failed
    .map((c) => {
      const output = c.output.length > FAILURE_OUTPUT_LIMIT ? `…${c.output.slice(-FAILURE_OUTPUT_LIMIT)}` : c.output;
      // Four backticks, so a ``` inside the output cannot end the block early.
      return `### \`${c.command}\` (${describeExit(c)})\n\`\`\`\`\n${output}\n\`\`\`\``;
    })
    .join('\n\n');
  return renderPrompt(template, { ...taskValues(task), failures });
}
