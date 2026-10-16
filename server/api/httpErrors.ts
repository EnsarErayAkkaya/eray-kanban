import { ZodError } from 'zod';
import { ConflictError, NotFoundError, ProjectBusyError, StaleStatusError, ValidationError } from '../domain/errors';
import { IllegalTransitionError } from '../domain/taskMachine';

export interface HttpError {
  readonly status: number;
  readonly body: { readonly error: string; readonly issues?: readonly { path: string; message: string }[] };
}

export function toHttpError(err: unknown): HttpError | null {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'Invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
  if (err instanceof NotFoundError) return { status: 404, body: { error: err.message } };
  if (
    err instanceof ConflictError ||
    err instanceof IllegalTransitionError ||
    err instanceof StaleStatusError ||
    err instanceof ProjectBusyError
  ) {
    return { status: 409, body: { error: err.message } };
  }
  return null;
}
