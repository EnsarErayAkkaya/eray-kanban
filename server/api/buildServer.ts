import Fastify, { type FastifyInstance } from 'fastify';
import { toHttpError } from './httpErrors';
import { localOnly } from './localOnly';
import { type RouteDeps, registerRoutes } from './routes';

export interface ServerOptions {
  readonly logger: boolean;
  /** The API port plus the Vite dev server port, whose proxy forwards the browser's Host and Origin. */
  readonly allowedPorts: readonly number[];
}

export function buildServer(deps: RouteDeps, options: ServerOptions): FastifyInstance {
  // Open SSE streams would otherwise keep close() waiting forever.
  const app = Fastify({ logger: options.logger, forceCloseConnections: true });

  app.addHook('onRequest', localOnly({ ports: options.allowedPorts }));
  app.setErrorHandler(async (err, req, reply) => {
    const mapped = toHttpError(err);
    if (mapped) return reply.code(mapped.status).send(mapped.body);
    const status = typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 500;
    if (status >= 500) req.log.error({ err }, 'Request failed');
    const message = status < 500 && err instanceof Error ? err.message : 'Internal error';
    return reply.code(status).send({ error: message });
  });

  registerRoutes(app, deps);
  return app;
}
