import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type TaskStatus } from '@shared/taskStatus';
import {
  IllegalTransitionError,
  TASK_EVENTS,
  canTransition,
  nextStatus,
  occupiesProject,
  transition,
  type TaskEvent,
} from './taskMachine';

// Written out by hand so the test is a spec, not a copy of the table.
const ALLOWED: ReadonlyArray<[TaskStatus, TaskEvent, TaskStatus]> = [
  ['backlog', 'promote', 'todo'],
  ['todo', 'demote', 'backlog'],
  ['todo', 'start', 'in_progress'],
  ['in_progress', 'askInput', 'needs_input'],
  ['needs_input', 'answer', 'in_progress'],
  ['in_progress', 'submit', 'in_review'],
  ['in_review', 'reject', 'in_progress'],
  ['in_review', 'accept', 'done'],
  ['backlog', 'cancel', 'cancelled'],
  ['todo', 'cancel', 'cancelled'],
  ['in_progress', 'cancel', 'cancelled'],
  ['needs_input', 'cancel', 'cancelled'],
  ['in_review', 'cancel', 'cancelled'],
  ['cancelled', 'reopen', 'backlog'],
];

const isAllowed = (from: TaskStatus, event: TaskEvent) =>
  ALLOWED.some(([f, e]) => f === from && e === event);

const ILLEGAL = TASK_STATUSES.flatMap((from) =>
  TASK_EVENTS.filter((event) => !isAllowed(from, event)).map((event) => [from, event] as const),
);

describe('taskMachine', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, event, to) => {
    expect(canTransition(from, event)).toBe(true);
    expect(nextStatus(from, event)).toBe(to);
  });

  it.each(ILLEGAL)('rejects %s --%s', (from, event) => {
    expect(canTransition(from, event)).toBe(false);
    expect(() => nextStatus(from, event)).toThrow(IllegalTransitionError);
  });

  it('covers every status/event pair', () => {
    expect(ALLOWED.length + ILLEGAL.length).toBe(TASK_STATUSES.length * TASK_EVENTS.length);
  });

  it('keeps done terminal and lets cancelled only reopen', () => {
    for (const event of TASK_EVENTS) {
      expect(canTransition('done', event)).toBe(false);
      expect(canTransition('cancelled', event)).toBe(event === 'reopen');
    }
  });

  it('reports the rejected status and event on the error', () => {
    const err = (() => {
      try {
        nextStatus('done', 'reject');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err).toMatchObject({ from: 'done', event: 'reject' });
  });

  describe('transition', () => {
    it('describes the change without touching the task', () => {
      const task = { id: 7, status: 'todo' as TaskStatus };
      expect(transition(task, 'start')).toEqual({ taskId: 7, event: 'start', from: 'todo', to: 'in_progress' });
      expect(task.status).toBe('todo');
    });

    it('throws on an illegal event', () => {
      expect(() => transition({ id: 7, status: 'backlog' }, 'accept')).toThrow(IllegalTransitionError);
    });
  });

  it.each([
    ['backlog', false],
    ['todo', false],
    ['in_progress', true],
    ['needs_input', true],
    ['in_review', true],
    ['done', false],
    ['cancelled', false],
  ] as const)('occupiesProject(%s) is %s', (status, expected) => {
    expect(occupiesProject(status)).toBe(expected);
  });
});
