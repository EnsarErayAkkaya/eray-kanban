import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/task';
import { renderCheckFixPrompt, renderFeedbackPrompt, renderTaskPrompt } from './taskPrompt';

const template = fs.readFileSync(new URL('./prompts/task.md', import.meta.url), 'utf8');

const task: Task = {
  id: 42,
  projectId: 1,
  title: 'Add settings page',
  description: 'Users need a page to change their email.',
  acceptanceCriteria: '- /settings shows the current email\n- Saving updates it',
  status: 'in_progress',
  priority: 'normal',
  position: 1,
  visual: false,
  routes: [],
  model: 'sonnet',
  turnLimit: 30,
  dependsOn: null,
  gitIssue: null,
  gitIssueDetail: null,
  pendingPush: null,
  commitSha: null,
  createdAt: '2026-10-16T09:00:00.000Z',
  updatedAt: '2026-10-16T09:00:00.000Z',
};

describe('renderTaskPrompt', () => {
  it('fills title, description and acceptance criteria', () => {
    const prompt = renderTaskPrompt(template, task);
    expect(prompt).toContain('# Task #42: Add settings page');
    expect(prompt).toContain('Users need a page to change their email.');
    expect(prompt).toContain('## Acceptance criteria\n- /settings shows the current email');
    expect(prompt).not.toMatch(/\{\{/);
  });

  it('drops empty sections', () => {
    const prompt = renderTaskPrompt(template, { ...task, description: '  ', acceptanceCriteria: '' });
    expect(prompt).not.toContain('## Acceptance criteria');
    expect(prompt).toMatch(/^# Task #42: Add settings page\n\n## Rules/);
  });

  it('asks for routes only for a visual task that lists none', () => {
    const ask = 'Add `"routes"` to your done JSON';
    expect(renderTaskPrompt(template, { ...task, visual: true, routes: [] })).toContain(ask);
    expect(renderTaskPrompt(template, { ...task, visual: true, routes: ['/settings'] })).not.toContain(ask);
    expect(renderTaskPrompt(template, task)).not.toContain(ask);
    expect(renderTaskPrompt(template, { ...task, visual: true })).toMatch(/its root\.\n- This is a visual task[^\n]*\n\n## Finish/);
    expect(renderTaskPrompt(template, task)).toMatch(/its root\.\n\n## Finish/);
    expect(renderTaskPrompt(template, task)).toContain('`@path` in this task is a file or folder in the repo');
  });

  it('does not expand placeholders written inside the task text', () => {
    const prompt = renderTaskPrompt(template, { ...task, title: 'Fix {{description}} rendering' });
    expect(prompt).toContain('# Task #42: Fix {{description}} rendering');
  });

  it('renders the feedback prompt with the feedback text', () => {
    const feedback = fs.readFileSync(new URL('./prompts/feedback.md', import.meta.url), 'utf8');
    const prompt = renderFeedbackPrompt(feedback, task, '  Use a toggle, not a checkbox.\n');
    expect(prompt).toMatch(/^Review feedback on task #42: Add settings page\n\nUse a toggle, not a checkbox.\n\n/);
    expect(prompt).not.toMatch(/\{\{/);
  });

  it('renders only the failing checks with the end of their output', () => {
    const template = fs.readFileSync(new URL('./prompts/checkFix.md', import.meta.url), 'utf8');
    const long = `${'x'.repeat(10_000)}\nsrc/a.ts(3,1): error TS2322`;
    const prompt = renderCheckFixPrompt(template, task, [
      { command: 'npm run typecheck', exitCode: 2, passed: false, timedOut: false, durationMs: 9, output: long },
      { command: 'npm test', exitCode: null, passed: false, timedOut: true, durationMs: 9, output: '```still running' },
    ]);
    expect(prompt).toContain('### `npm run typecheck` (exit 2)');
    expect(prompt).toContain('src/a.ts(3,1): error TS2322');
    expect(prompt).toContain('### `npm test` (timed out)');
    expect(prompt).toContain('````\n```still running\n````');
    expect(prompt.length).toBeLessThan(9_000);
    expect(prompt).toContain('without skipping, disabling or weakening any check');
  });

  it('stays short: no file contents, diffs or project rules', () => {
    expect(renderTaskPrompt(template, task).length).toBeLessThan(1_200);
  });
});
