import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export function createGateway(log: (entry: Record<string, unknown>) => void = () => {}) {
  let draining = false;
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const start = performance.now();
    response.setHeader('X-Request-ID', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.once('finish', () => log({
      event: 'http_response', requestId, status: response.statusCode,
      elapsedMs: Math.round(performance.now() - start),
    }));

    if (request.url === '/health' && request.method === 'GET') {
      response.statusCode = draining ? 503 : 200;
      response.end(JSON.stringify({ ready: !draining }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND', requestId }));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server,
    drain() {
      draining = true;
      server.close();
    },
  };
}
