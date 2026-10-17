// Agent Kanban helper for the kanban skill. Runs with plain `node kanban.ts` (Node 24+), no dependencies.
import fs from 'node:fs';

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export const MODELS = ['sonnet', 'opus', 'haiku'] as const;
type Priority = (typeof PRIORITIES)[number];
type Model = (typeof MODELS)[number];

export interface Project {
  readonly id: number;
  readonly name: string;
  readonly repoPath: string;
  readonly workingBranch: string;
  readonly paused?: boolean;
}

export interface BoardTask {
  readonly id: number;
  readonly projectId: number;
  readonly title: string;
  readonly status: string;
  readonly dependsOn: number | null;
}

export interface Template {
  readonly name: string;
  readonly titlePrefix: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly priority: Priority;
  readonly visual: boolean;
  readonly routes: readonly string[];
  readonly model: Model | null;
  readonly turnLimit: number | null;
}

/** null: no dependency; a number: an existing board task; new: an earlier task in the same plan. */
export type DependencyRef = null | { readonly kind: 'existing'; readonly id: number } | { readonly kind: 'new'; readonly index: number };

export interface Draft {
  readonly key: string | null;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly priority: Priority;
  readonly visual: boolean;
  readonly routes: readonly string[];
  readonly model: Model | null;
  readonly turnLimit: number | null;
  readonly dependsOn: DependencyRef;
}

export interface ResolvedPlan {
  readonly projectId: number;
  readonly drafts: readonly Draft[];
}

const ITEM_FIELDS = new Set([
  'key',
  'title',
  'description',
  'acceptanceCriteria',
  'priority',
  'visual',
  'routes',
  'model',
  'turnLimit',
  'template',
  'dependsOn',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Git Bash /c/x, C:\x and c:/x all become c:/x on Windows; trailing slashes go. */
export function normalizePath(p: string, windows: boolean): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (windows) {
    s = s.replace(/^\/([a-zA-Z])\//, '$1:/').replace(/^\/([a-zA-Z])$/, '$1:');
    s = s.toLowerCase();
  }
  return s;
}

/** The project whose repo contains dir; the deepest one wins. */
export function findProject(projects: readonly Project[], dir: string, windows: boolean): Project | undefined {
  const here = normalizePath(dir, windows);
  return projects
    .filter((p) => {
      const repo = normalizePath(p.repoPath, windows);
      return here === repo || here.startsWith(`${repo}/`);
    })
    .sort((a, b) => b.repoPath.length - a.repoPath.length)[0];
}

/** Checks the plan file and applies templates; every problem is reported at once. */
export function resolvePlan(
  raw: unknown,
  existing: readonly BoardTask[],
  templates: readonly Template[],
): { ok: true; plan: ResolvedPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['The plan must be a JSON object with projectId and tasks'] };
  const projectId = raw.projectId;
  if (typeof projectId !== 'number' || !Number.isInteger(projectId) || projectId < 1) errors.push('projectId must be a positive integer');
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    errors.push('tasks must be a non-empty array');
    return { ok: false, errors };
  }

  const keys = new Map<string, number>();
  const drafts: Draft[] = [];
  raw.tasks.forEach((item: unknown, index) => {
    const where = `tasks[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const field of Object.keys(item)) {
      if (!ITEM_FIELDS.has(field)) errors.push(`${where}: unknown field "${field}"`);
    }

    let template: Template | undefined;
    if (item.template !== undefined) {
      template = templates.find((t) => typeof item.template === 'string' && t.name.toLowerCase() === item.template.toLowerCase());
      if (!template) errors.push(`${where}: no template named "${String(item.template)}" (have: ${templates.map((t) => t.name).join(', ') || 'none'})`);
    }

    const key = item.key === undefined ? null : item.key;
    if (key !== null && (typeof key !== 'string' || key.trim() === '')) errors.push(`${where}: key must be a non-empty string`);
    else if (key !== null && keys.has(key)) errors.push(`${where}: key "${key}" is used twice`);

    const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
    if (rawTitle === '') errors.push(`${where}: title is required`);
    const prefix = template?.titlePrefix ?? '';
    const title = prefix && !rawTitle.startsWith(prefix) ? `${prefix}${rawTitle}` : rawTitle;
    if (title.length > 200) errors.push(`${where}: title is longer than 200 characters`);

    const text = (field: 'description' | 'acceptanceCriteria', max: number): string => {
      const value = item[field] ?? template?.[field] ?? '';
      if (typeof value !== 'string') {
        errors.push(`${where}: ${field} must be a string`);
        return '';
      }
      if (value.length > max) errors.push(`${where}: ${field} is longer than ${max} characters`);
      return value;
    };
    const description = text('description', 20_000);
    const acceptanceCriteria = text('acceptanceCriteria', 10_000);

    const priority = item.priority ?? template?.priority ?? 'normal';
    if (!PRIORITIES.includes(priority as Priority)) errors.push(`${where}: priority must be one of ${PRIORITIES.join(', ')}`);
    const visual = item.visual ?? template?.visual ?? false;
    if (typeof visual !== 'boolean') errors.push(`${where}: visual must be true or false`);
    const routes = item.routes ?? template?.routes ?? [];
    if (!Array.isArray(routes) || routes.length > 20 || routes.some((r) => typeof r !== 'string' || !r.startsWith('/') || r.length > 200)) {
      errors.push(`${where}: routes must be up to 20 paths starting with /, each at most 200 characters`);
    }
    const model = item.model ?? template?.model ?? null;
    if (model !== null && !MODELS.includes(model as Model)) errors.push(`${where}: model must be one of ${MODELS.join(', ')}`);
    const turnLimit = item.turnLimit ?? template?.turnLimit ?? null;
    if (turnLimit !== null && (typeof turnLimit !== 'number' || !Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 500)) {
      errors.push(`${where}: turnLimit must be a whole number from 1 to 500`);
    }

    let dependsOn: DependencyRef = null;
    const dep = item.dependsOn ?? null;
    if (typeof dep === 'string') {
      // Only earlier keys, so the plan creates in order and cannot loop.
      const target = keys.get(dep);
      if (target === undefined) errors.push(`${where}: dependsOn "${dep}" must be the key of an earlier task in this plan`);
      else dependsOn = { kind: 'new', index: target };
    } else if (typeof dep === 'number') {
      const target = existing.find((t) => t.id === dep);
      if (!target || target.projectId !== projectId) errors.push(`${where}: dependsOn #${dep} is not a task in this project`);
      else if (target.status === 'cancelled') errors.push(`${where}: dependsOn #${dep} is cancelled, so this task would never start`);
      else dependsOn = { kind: 'existing', id: dep };
    } else if (dep !== null) {
      errors.push(`${where}: dependsOn must be an earlier key, an existing task id, or null`);
    }

    if (typeof key === 'string' && key.trim() !== '' && !keys.has(key)) keys.set(key, index);
    drafts.push({
      key: typeof key === 'string' ? key : null,
      title,
      description,
      acceptanceCriteria,
      priority: priority as Priority,
      visual: visual === true,
      routes: Array.isArray(routes) ? routes.filter((r): r is string => typeof r === 'string') : [],
      model: model as Model | null,
      turnLimit: typeof turnLimit === 'number' ? turnLimit : null,
      dependsOn,
    });
  });

  if (errors.length > 0 || typeof projectId !== 'number') return { ok: false, errors };
  return { ok: true, plan: { projectId, drafts } };
}

/** The POST /api/tasks body; createdIds holds the ids of the plan's tasks created so far, by index. */
export function toCreateBody(projectId: number, draft: Draft, createdIds: readonly number[]): Record<string, unknown> {
  const dep = draft.dependsOn;
  let dependsOn: number | null = null;
  if (dep?.kind === 'existing') dependsOn = dep.id;
  else if (dep?.kind === 'new') {
    const id = createdIds[dep.index];
    if (id === undefined) throw new Error(`Task ${dep.index + 1} of the plan was not created yet`);
    dependsOn = id;
  }
  return {
    projectId,
    title: draft.title,
    description: draft.description,
    acceptanceCriteria: draft.acceptanceCriteria,
    priority: draft.priority,
    visual: draft.visual,
    routes: draft.routes,
    ...(draft.model === null ? {} : { model: draft.model }),
    ...(draft.turnLimit === null ? {} : { turnLimit: draft.turnLimit }),
    dependsOn,
  };
}

function describeDraft(draft: Draft, index: number, drafts: readonly Draft[]): string {
  const dep = draft.dependsOn;
  const after =
    dep === null ? '' : dep.kind === 'existing' ? ` (after #${dep.id})` : ` (after plan task ${dep.index + 1}: ${drafts[dep.index]?.title ?? '?'})`;
  const extras = [draft.priority !== 'normal' ? draft.priority : '', draft.model ?? '', draft.visual ? `visual ${draft.routes.join(' ')}`.trim() : '']
    .filter(Boolean)
    .join(', ');
  return `  ${index + 1}. ${draft.title}${after}${extras ? ` [${extras}]` : ''}`;
}

class BoardError extends Error {}

async function call<T>(base: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new BoardError(`Agent Kanban is not reachable at ${base}. Is it running?`);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = isRecord(data) && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
    const issues = isRecord(data) && Array.isArray(data.issues) ? data.issues.map((i) => (isRecord(i) ? `${String(i.path)}: ${String(i.message)}` : '')).join('; ') : '';
    throw new BoardError(issues || message);
  }
  return data as T;
}

const OPEN = new Set(['backlog', 'todo', 'in_progress', 'needs_input', 'in_review']);

async function main(argv: readonly string[]): Promise<void> {
  const base = (process.env.KANBAN_URL ?? 'http://127.0.0.1:4317').replace(/\/+$/, '');
  const windows = process.platform === 'win32';
  const [command, arg, flag] = argv;

  switch (command) {
    case 'projects': {
      for (const p of await call<Project[]>(base, 'GET', '/projects')) {
        console.log(`#${p.id} ${p.name}  ${p.repoPath}  branch ${p.workingBranch}${p.paused ? '  (paused)' : ''}`);
      }
      return;
    }
    case 'here': {
      const project = findProject(await call<Project[]>(base, 'GET', '/projects'), arg ?? process.cwd(), windows);
      if (!project) throw new BoardError(`No board project contains ${arg ?? process.cwd()}. Add it in Agent Kanban first, or run "projects".`);
      console.log(`#${project.id} ${project.name}  ${project.repoPath}  branch ${project.workingBranch}${project.paused ? '  (paused)' : ''}`);
      return;
    }
    case 'tasks': {
      const projectId = Number(arg);
      const tasks = (await call<BoardTask[]>(base, 'GET', '/tasks')).filter((t) => t.projectId === projectId && OPEN.has(t.status));
      if (tasks.length === 0) console.log('No open tasks.');
      for (const t of tasks) console.log(`#${t.id} [${t.status}] ${t.title}${t.dependsOn ? ` (after #${t.dependsOn})` : ''}`);
      return;
    }
    case 'templates': {
      const templates = await call<Template[]>(base, 'GET', `/projects/${Number(arg)}/templates`);
      if (templates.length === 0) console.log('No templates.');
      for (const t of templates) {
        const bits = [t.titlePrefix && `prefix "${t.titlePrefix}"`, t.priority, t.model ?? 'project model', t.turnLimit ? `${t.turnLimit} turns` : '', t.visual ? `visual ${t.routes.join(' ')}` : '']
          .filter(Boolean)
          .join(', ');
        console.log(`${t.name}: ${bits}`);
      }
      return;
    }
    case 'create': {
      if (!arg) throw new BoardError('Usage: node kanban.ts create <plan.json> [--dry-run]');
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(arg, 'utf8'));
      } catch (err) {
        throw new BoardError(`Could not read ${arg}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const projectId = isRecord(raw) ? Number(raw.projectId) : NaN;
      const project = (await call<Project[]>(base, 'GET', '/projects')).find((p) => p.id === projectId);
      if (!project) throw new BoardError(`No project #${String(isRecord(raw) ? raw.projectId : '?')} on the board`);
      const [existing, templates] = await Promise.all([
        call<BoardTask[]>(base, 'GET', '/tasks'),
        call<Template[]>(base, 'GET', `/projects/${projectId}/templates`),
      ]);
      const resolved = resolvePlan(raw, existing, templates);
      if (!resolved.ok) throw new BoardError(`The plan has problems; nothing was created:\n${resolved.errors.map((e) => `  - ${e}`).join('\n')}`);

      const { drafts } = resolved.plan;
      if (flag === '--dry-run') {
        console.log(`Plan is valid. Would create ${drafts.length} Backlog tasks in ${project.name}:`);
        drafts.forEach((d, i) => console.log(describeDraft(d, i, drafts)));
        return;
      }

      const created: number[] = [];
      for (const [i, draft] of drafts.entries()) {
        try {
          const task = await call<BoardTask>(base, 'POST', '/tasks', toCreateBody(projectId, draft, created));
          created.push(task.id);
        } catch (err) {
          const done = created.map((id, n) => `  #${id} ${drafts[n]?.title ?? ''}`).join('\n');
          throw new BoardError(
            `Stopped at plan task ${i + 1} (${draft.title}): ${err instanceof Error ? err.message : String(err)}\n` +
              (created.length ? `Already created, do not create these again:\n${done}` : 'Nothing was created.'),
          );
        }
      }
      console.log(`Created ${created.length} Backlog tasks in ${project.name}:`);
      drafts.forEach((d, i) => {
        const dep = d.dependsOn;
        const after = dep === null ? '' : ` (after #${dep.kind === 'existing' ? dep.id : created[dep.index]})`;
        console.log(`  #${created[i]} ${d.title}${after}`);
      });
      return;
    }
    default:
      console.log('Usage: node kanban.ts projects | here [dir] | tasks <projectId> | templates <projectId> | create <plan.json> [--dry-run]');
      if (command !== undefined && command !== 'help') process.exitCode = 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof BoardError ? err.message : err);
    process.exitCode = 1;
  });
}
