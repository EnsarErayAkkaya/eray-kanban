import { useCallback, useState } from 'react';
import type { Task } from '@shared/task';
import { usageTotals } from '../state/boardState';
import { useBoard } from '../state/useBoard';
import { Board } from './Board';
import { ProjectForm } from './ProjectForm';
import { ReviewPanel } from './ReviewPanel';
import { Sheet } from './Sheet';
import type { CardActionId } from './TaskCard';
import { TaskForm } from './TaskForm';
import { MemoryEditor } from './MemoryEditor';
import { TemplatesEditor } from './TemplatesEditor';
import { UsageSummary } from './UsageSummary';

type Panel = 'none' | 'project' | 'settings' | 'task';

export function App() {
  const { state, actions } = useBoard();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [editTaskId, setEditTaskId] = useState<number | null>(null);

  const visibleTasks = projectId === null ? state.tasks : state.tasks.filter((t) => t.projectId === projectId);
  // Settings act on the filtered project, or on the only one there is.
  const settingsProject = state.projects.find((p) => p.id === projectId) ?? (state.projects.length === 1 ? state.projects[0] : undefined);
  const openTask = state.tasks.find((t) => t.id === openTaskId);
  const editTask = state.tasks.find((t) => t.id === editTaskId);
  const closeReview = useCallback(() => setOpenTaskId(null), []);
  const closeEdit = useCallback(() => setEditTaskId(null), []);
  const closePanel = useCallback(() => setPanel('none'), []);

  const openReview = (task: Task) => {
    setOpenTaskId(task.id);
    void actions.loadHistory(task.id);
  };

  const onAction = (task: Task, action: CardActionId) => {
    switch (action) {
      case 'promote':
      case 'demote':
        return void actions.sendEvent(task.id, action);
      case 'stop':
        return void actions.stop(task.id);
      case 'cancel':
        return void actions.review(task.id, { kind: 'cancel' });
      case 'open':
        return openReview(task);
      case 'retryPush':
        return void actions.review(task.id, { kind: 'retryPush' });
      case 'resolveIssue':
        return void actions.review(task.id, { kind: 'resolveIssue' });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">Agent Kanban</h1>
        <select
          aria-label="Project filter"
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All projects</option>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!settingsProject}
          title={settingsProject ? undefined : 'Pick a project first'}
          onClick={() => setPanel('settings')}
        >
          Project settings
        </button>
        <UsageSummary totals={usageTotals(state.usage, projectId)} />
        <div className="topbar__spacer" />
        <span className={`status${state.connected ? ' status--live' : ''}`}>{state.connected ? 'Live' : 'Offline'}</span>
        <button className="btn" onClick={() => setPanel('project')}>
          New project
        </button>
        <button className="btn btn--primary" disabled={state.projects.length === 0} onClick={() => setPanel('task')}>
          New task
        </button>
      </header>

      {state.error && (
        <div className="banner" role="alert">
          {state.error}
          <button className="btn btn--small btn--ghost" onClick={actions.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      {state.projects
        .filter((p) => state.blocked[p.id] !== undefined && (projectId === null || projectId === p.id))
        .map((p) => (
          <div key={p.id} className="banner banner--warn" role="status">
            <span>
              <strong>{p.name}</strong> is waiting: {state.blocked[p.id]}
            </span>
            <button className="btn btn--small" onClick={() => void actions.checkProject(p.id)}>
              Check again
            </button>
          </div>
        ))}

      {panel === 'project' && (
        <Sheet label="New project" onClose={closePanel}>
          <ProjectForm onSubmit={actions.createProject} onClose={closePanel} />
        </Sheet>
      )}
      {panel === 'settings' && settingsProject && (
        <Sheet label={`${settingsProject.name} settings`} onClose={closePanel}>
          <ProjectForm
            key={settingsProject.id}
            project={settingsProject}
            onSubmit={(draft) => actions.updateProject(settingsProject.id, draft)}
            onClose={closePanel}
          />
          <TemplatesEditor key={`templates-${settingsProject.id}`} projectId={settingsProject.id} />
          <MemoryEditor key={`memory-${settingsProject.id}`} projectId={settingsProject.id} />
        </Sheet>
      )}
      {panel === 'task' && (
        <Sheet label="New task" onClose={closePanel}>
          <TaskForm
            projects={state.projects}
            tasks={state.tasks}
            defaultProjectId={projectId}
            onSubmit={actions.createTask}
            onClose={closePanel}
          />
        </Sheet>
      )}

      {editTask && (
        <Sheet label={`Edit task ${editTask.id}`} onClose={closeEdit}>
          <TaskForm
            key={editTask.id}
            projects={state.projects}
            tasks={state.tasks}
            defaultProjectId={editTask.projectId}
            task={editTask}
            onSubmit={(draft) => actions.editTask(editTask, draft)}
            onClose={closeEdit}
          />
        </Sheet>
      )}

      {state.loaded && state.projects.length === 0 ? (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>A project is a local git repo. Each one gets its own agent, which works through its tasks one at a time.</p>
          <button className="btn btn--primary" onClick={() => setPanel('project')}>
            New project
          </button>
        </div>
      ) : (
        <Board
          tasks={visibleTasks}
          projects={state.projects}
          showProjectNames={projectId === null && state.projects.length > 1}
          runs={state.runs}
          logs={state.logs}
          onAction={onAction}
          onOpenLog={(task) => void actions.loadHistory(task.id)}
        />
      )}

      {openTask && (
        <ReviewPanel
          key={openTask.id}
          task={openTask}
          project={state.projects.find((p) => p.id === openTask.projectId)}
          runs={state.runs[openTask.id] ?? []}
          log={state.logs[openTask.id] ?? []}
          dependency={state.tasks.find((t) => t.id === openTask.dependsOn) ?? null}
          onReview={(action) => actions.review(openTask.id, action, true)}
          onStop={() => void actions.stop(openTask.id)}
          onEdit={() => {
            setOpenTaskId(null);
            setEditTaskId(openTask.id);
          }}
          onDelete={() => actions.deleteTask(openTask.id)}
          onClose={closeReview}
        />
      )}
    </div>
  );
}
