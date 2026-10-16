import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CONTROL_HEADER } from '@shared/control';

export interface ControlDeps {
  readonly token: string;
  /** Stops agents and the server, like Ctrl+C; called after the reply is sent. */
  readonly shutdown: () => void;
}

function matches(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export function registerControl(app: FastifyInstance, deps: ControlDeps): void {
  app.post('/api/shutdown', async (req, reply) => {
    if (!matches(req.headers[CONTROL_HEADER], deps.token)) return reply.code(403).send({ error: 'Wrong or missing control token' });
    reply.code(202).send({ stopping: true });
    // Let the reply leave before the server starts closing its connections.
    setImmediate(deps.shutdown);
    return reply;
  });
}
