import type { NewTemplate, TaskTemplate, TemplatePatch } from '@shared/template';
import { NotFoundError } from '../domain/errors';
import type { ProjectRepo, TemplateRepo } from './ports';

/** Templates only pre-fill the task form; tasks never refer back to them. */
export class TemplateService {
  constructor(
    private readonly _projects: ProjectRepo,
    private readonly _templates: TemplateRepo,
  ) {}

  list(projectId: number): TaskTemplate[] {
    this._requireProject(projectId);
    return this._templates.listByProject(projectId);
  }

  create(projectId: number, template: NewTemplate): TaskTemplate {
    this._requireProject(projectId);
    return this._templates.create(projectId, template);
  }

  update(id: number, patch: TemplatePatch): TaskTemplate {
    return this._templates.update(id, patch);
  }

  delete(id: number): void {
    this._templates.delete(id);
  }

  private _requireProject(projectId: number): void {
    if (!this._projects.get(projectId)) throw new NotFoundError('project', projectId);
  }
}
