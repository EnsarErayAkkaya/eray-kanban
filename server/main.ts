import Fastify from 'fastify';

// Invariant 8: never bind to anything but loopback.
const HOST = '127.0.0.1';
const PORT = Number(process.env.KANBAN_PORT ?? 4317);

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  app.get('/api/health', async () => ({ ok: true }));
  await app.listen({ host: HOST, port: PORT });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
