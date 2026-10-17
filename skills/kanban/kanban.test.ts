import { describe, expect, it } from 'vitest';
import { type BoardTask, type Project, type Template, findProject, normalizePath, resolvePlan, toCreateBody } from './kanban';

const project = (id: number, repoPath: string): Project => ({ id, name: `p${id}`, repoPath, workingBranch: 'develop' });
const boardTask = (id: number, status = 'backlog', projectId = 1): BoardTask => ({ id, projectId, title: `Task ${id}`, status, dependsOn: null });
const uiTemplate: Template = {
  name: 'UI change',
  titlePrefix: 'UI: ',
  description: 'Template text',
  acceptanceCriteria: 'Looks right on mobile',
  priority: 'high',
  visual: true,
  routes: ['/'],
  model: null,
  turnLimit: 20,
};

const resolve = (tasks: unknown[], existing: BoardTask[] = [], templates: Template[] = []) =>
  resolvePlan({ projectId: 1, tasks }, existing, templates);

describe('normalizePath', () => {
  it('treats Git Bash, backslash and forward-slash Windows paths alike', () => {
    expect(normalizePath('/c/Users/Me/shop/', true)).toBe('c:/users/me/shop');
    expect(normalizePath('C:\\Users\\Me\\shop', true)).toBe('c:/users/me/shop');
    expect(normalizePath('/home/me/Shop/', false)).toBe('/home/me/Shop');
  });
});

describe('findProject', () => {
  const projects = [project(1, 'C:\\repos\\shop'), project(2, 'C:\\repos\\shop\\admin'), project(3, 'C:\\repos\\shopfront')];

  it('finds the repo containing the folder, the deepest one first', () => {
    expect(findProject(projects, '/c/repos/shop/src', true)?.id).toBe(1);
    expect(findProject(projects, 'C:/repos/shop/admin/src', true)?.id).toBe(2);
    expect(findProject(projects, 'c:\\repos\\shopfront', true)?.id).toBe(3);
  });

  it('does not match a sibling folder that only shares a prefix', () => {
    expect(findProject([project(1, '/repos/shop')], '/repos/shop-old', false)).toBeUndefined();
  });
});

describe('resolvePlan', () => {
  it('fills defaults and links keys to earlier tasks', () => {
    const result = resolve([{ key: 'a', title: ' First ' }, { title: 'Second', dependsOn: 'a' }]);
    expect(result).toMatchObject({
      ok: true,
      plan: {
        projectId: 1,
        drafts: [
          { title: 'First', priority: 'normal', visual: false, routes: [], model: null, turnLimit: null, dependsOn: null },
          { title: 'Second', dependsOn: { kind: 'new', index: 0 } },
        ],
      },
    });
  });

  it('applies a template under the task own fields', () => {
    const result = resolve([{ title: 'Bigger buttons', template: 'ui change', routes: ['/cart'] }], [], [uiTemplate]);
    expect(result).toMatchObject({
      ok: true,
      plan: {
        drafts: [
          {
            title: 'UI: Bigger buttons',
            description: 'Template text',
            acceptanceCriteria: 'Looks right on mobile',
            priority: 'high',
            visual: true,
            routes: ['/cart'],
            turnLimit: 20,
          },
        ],
      },
    });
  });

  it('accepts an open task of the project as a dependency', () => {
    expect(resolve([{ title: 'x', dependsOn: 7 }], [boardTask(7, 'todo')])).toMatchObject({
      ok: true,
      plan: { drafts: [{ dependsOn: { kind: 'existing', id: 7 } }] },
    });
  });

  it('reports every problem at once', () => {
    const result = resolve(
      [
        { title: '', criteria: 'typo' },
        { title: 'Later key', dependsOn: 'b' },
        { key: 'b', title: 'B', priority: 'urgent', model: 'gpt', turnLimit: 0, routes: ['cart'] },
        { key: 'b', title: 'Dup' },
        { title: 'Other project', dependsOn: 8 },
        { title: 'Cancelled', dependsOn: 9 },
        { title: 'No template', template: 'Nope' },
      ],
      [boardTask(8, 'todo', 2), boardTask(9, 'cancelled')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'tasks[0]: unknown field "criteria"',
      'tasks[0]: title is required',
      'tasks[1]: dependsOn "b" must be the key of an earlier task in this plan',
      'tasks[2]: priority must be one of high, normal, low',
      'tasks[2]: routes must be up to 20 paths starting with /, each at most 200 characters',
      'tasks[2]: model must be one of sonnet, opus, haiku',
      'tasks[2]: turnLimit must be a whole number from 1 to 500',
      'tasks[3]: key "b" is used twice',
      'tasks[4]: dependsOn #8 is not a task in this project',
      'tasks[5]: dependsOn #9 is cancelled, so this task would never start',
      'tasks[6]: no template named "Nope" (have: none)',
    ]);
  });

  it('refuses a plan without tasks or a project', () => {
    expect(resolvePlan({ tasks: [] }, [], [])).toEqual({
      ok: false,
      errors: ['projectId must be a positive integer', 'tasks must be a non-empty array'],
    });
  });
});

describe('toCreateBody', () => {
  it('turns plan links into the ids created so far and leaves defaults to the project', () => {
    const result = resolve([{ key: 'a', title: 'A' }, { title: 'B', dependsOn: 'a', model: 'opus' }]);
    if (!result.ok) throw new Error(result.errors.join());
    const [a, b] = result.plan.drafts;
    if (!a || !b) throw new Error('missing drafts');
    expect(toCreateBody(1, a, [])).not.toHaveProperty('model');
    expect(toCreateBody(1, b, [41])).toMatchObject({ projectId: 1, title: 'B', model: 'opus', dependsOn: 41 });
    expect(() => toCreateBody(1, b, [])).toThrow('was not created yet');
  });
});
