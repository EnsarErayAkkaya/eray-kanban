import type { FastifyReply, FastifyRequest } from 'fastify';

export interface LocalOnlyOptions {
  readonly ports: readonly number[];
}

// Binding to 127.0.0.1 is not enough: any web page you visit can send requests to it,
// and a DNS-rebinding page can even read the answers. Both carry a foreign Host or Origin.
export function localOnly({ ports }: LocalOnlyOptions) {
  const hosts = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { host, origin } = req.headers;
    if (!host || !hosts.has(host)) {
      await reply.code(403).send({ error: 'Unknown host' });
      return;
    }
    if (origin !== undefined && !origins.has(origin)) {
      await reply.code(403).send({ error: 'Cross-origin requests are not allowed' });
    }
  };
}
