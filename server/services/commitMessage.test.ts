import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/task';
import { commitMessage } from './commitMessage';

const task = { id: 42, title: 'Add settings page' } as Task;

describe('commitMessage', () => {
  it('fills the format and adds the summary as the body', () => {
    expect(commitMessage('feat(#{id}): {title}', task, 'Added /settings with an email field.')).toBe(
      'feat(#42): Add settings page\n\nAdded /settings with an email field.\n',
    );
  });

  it('is only a subject line when there is no summary', () => {
    expect(commitMessage('{title} (#{id})', task, null)).toBe('Add settings page (#42)\n');
    expect(commitMessage('{title}', task, '   ')).toBe('Add settings page\n');
  });

  it('keeps the subject on one line', () => {
    expect(commitMessage('feat: {title}', { ...task, title: 'Two\nlines' }, null)).toBe('feat: Two lines\n');
  });
});
