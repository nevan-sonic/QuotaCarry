import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { createInferenceApi } from './api.js';

export function createGateway(log: (entry: Record<string, unknown>) => void = () => {}, inference?: ReturnType<typeof createInferenceApi>) {
  let draining = false;
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const start = performance.now();
    response.setHeader('X-Request-ID', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
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
    if (request.url === '/ready' && request.method === 'GET') {
      response.statusCode = !draining && inference ? 200 : 503;
      response.end(JSON.stringify({inference: !draining && inference ? 'configured' : 'not_configured'}));
      return;
    }
    if (!draining && !inference && request.url?.startsWith('/v1/')) {
      response.statusCode = 503;
      response.end(JSON.stringify({error:'Inference gateway is not configured'}));
      return;
    }
    if (!draining && inference && request.url?.startsWith('/v1/')) {
      void inference.handle(request,response);
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
      inference?.close();
      server.close();
    },
  };
}
