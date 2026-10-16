import { describe, expect, it } from 'vitest';
import { CreateProjectInput, UpdateProjectInput } from './project';
import { ReviewJsonSchema } from './review';
import { CreateTaskInput, TaskEventInput, UpdateTaskInput } from './task';

const project = { name: 'shop', repoPath: '/repos/shop', workingBranch: 'develop' };

describe('project schemas', () => {
  it('fills defaults on create', () => {
    expect(CreateProjectInput.parse(project)).toMatchObject({
      type: 'web',
      mergeTarget: null,
      acceptCommit: true,
      acceptFollowup: 'none',
      defaultModel: 'sonnet',
      defaultTurnLimit: 30,
      allowedCommands: [],
    });
  });

  it.each(['--upload-pack=evil', '-f', 'a..b', 'feat branch', 'x;rm'])('rejects unsafe branch %j', (branch) => {
    expect(CreateProjectInput.safeParse({ ...project, workingBranch: branch }).success).toBe(false);
  });

  it('accepts normal branch names', () => {
    expect(CreateProjectInput.safeParse({ ...project, workingBranch: 'feature/m1-board', mergeTarget: 'main' }).success).toBe(
      true,
    );
  });

  it.each(['sh -c x', 'bash run.sh', 'git status', 'npm run x) Bash(*', 'npm run test && git push'])(
    'rejects allowed command %j',
    (cmd) => {
      expect(CreateProjectInput.safeParse({ ...project, allowedCommands: [cmd] }).success).toBe(false);
    },
  );

  it('accepts project script commands', () => {
    expect(CreateProjectInput.safeParse({ ...project, allowedCommands: ['npm run test', 'npx vitest run'] }).success).toBe(
      true,
    );
  });

  it('requires an absolute repo path', () => {
    expect(CreateProjectInput.safeParse({ ...project, repoPath: 'repos/shop' }).success).toBe(false);
  });

  it('does not fill defaults on update and rejects unknown fields', () => {
    expect(UpdateProjectInput.parse({ name: 'new' })).toEqual({ name: 'new' });
    expect(UpdateProjectInput.safeParse({ id: 3 }).success).toBe(false);
  });
});

describe('task schemas', () => {
  it('fills defaults on create and leaves model to the project', () => {
    const task = CreateTaskInput.parse({ projectId: '4', title: '  Add page  ' });
    expect(task).toEqual({
      projectId: 4,
      title: 'Add page',
      description: '',
      acceptanceCriteria: '',
      priority: 'normal',
      visual: false,
      routes: [],
      dependsOn: null,
    });
  });

  it('rejects a blank title and routes without a slash', () => {
    expect(CreateTaskInput.safeParse({ projectId: 1, title: '  ' }).success).toBe(false);
    expect(CreateTaskInput.safeParse({ projectId: 1, title: 'x', routes: ['settings'] }).success).toBe(false);
  });

  it('does not let an update change status or project', () => {
    expect(UpdateTaskInput.safeParse({ status: 'done' }).success).toBe(false);
    expect(UpdateTaskInput.safeParse({ projectId: 2 }).success).toBe(false);
    expect(UpdateTaskInput.parse({ priority: 'high' })).toEqual({ priority: 'high' });
  });

  it('accepts only known events', () => {
    expect(TaskEventInput.safeParse({ event: 'promote' }).success).toBe(true);
    expect(TaskEventInput.safeParse({ event: 'teleport' }).success).toBe(false);
  });
});

describe('ReviewJsonSchema', () => {
  it('parses a finished task', () => {
    expect(ReviewJsonSchema.parse({ outcome: 'done', summary: 'Added the page' })).toEqual({
      outcome: 'done',
      summary: 'Added the page',
      notes: [],
      concerns: [],
    });
  });

  it('parses a question', () => {
    expect(ReviewJsonSchema.parse({ outcome: 'needs_input', question: 'Which route?' })).toEqual({
      outcome: 'needs_input',
      question: 'Which route?',
      summary: '',
    });
  });

  it.each([
    {},
    { outcome: 'done' },
    { outcome: 'done', summary: '   ' },
    { outcome: 'needs_input', summary: 'no question' },
    { outcome: 'shipped', summary: 'x' },
  ])('rejects %j', (value) => {
    expect(ReviewJsonSchema.safeParse(value).success).toBe(false);
  });
});
