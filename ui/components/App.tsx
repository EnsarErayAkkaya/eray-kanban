import { useState } from 'react';
import type { Task } from '@shared/task';
import type { TaskEvent } from '@shared/taskStatus';
import { useBoard } from '../state/useBoard';
import { Board } from './Board';
import { ProjectForm } from './ProjectForm';
import { TaskForm } from './TaskForm';

type Panel = 'none' | 'project' | 'task';

export function App() {
  const { state, actions } = useBoard();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>('none');

  const visibleTasks = projectId === null ? state.tasks : state.tasks.filter((t) => t.projectId === projectId);
  const onAction = (task: Task, event: TaskEvent | 'stop') =>
    void (event === 'stop' ? actions.stop(task.id) : actions.sendEvent(task.id, event));

  return (
    <div className="app">
      <header className="topbar">
        <h1>Agent Kanban</h1>
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

      {panel === 'project' && <ProjectForm onSubmit={actions.createProject} onClose={() => setPanel('none')} />}
      {panel === 'task' && (
        <TaskForm
          projects={state.projects}
          defaultProjectId={projectId}
          onSubmit={actions.createTask}
          onClose={() => setPanel('none')}
        />
      )}

      {state.loaded && state.projects.length === 0 && panel === 'none' ? (
        <div className="empty">
          <p>Add a project to start: a local git repo the agent will work in.</p>
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
    </div>
  );
}
