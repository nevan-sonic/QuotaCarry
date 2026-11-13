import { readConfig } from './config.js';
import { createGateway } from './server.js';

function main() {
  const config = readConfig(process.env);
  const log = (entry: Record<string, unknown>) => process.stdout.write(JSON.stringify(entry) + '\n');
  const gateway = createGateway(log);
  gateway.server.on('error', (error: NodeJS.ErrnoException) => {
    log({ event: 'server_error', code: error.code ?? 'UNKNOWN' });
    process.exitCode = 1;
  });
  gateway.server.listen(config.port, config.host, () => log({ event: 'listening', port: config.port }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log({ event: 'shutdown', signal });
      gateway.drain();
      setTimeout(() => gateway.server.closeAllConnections(), 10_000).unref();
    });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(JSON.stringify({ event: 'invalid_configuration', message: error instanceof Error ? error.message : 'Invalid configuration' }) + '\n');
  process.exitCode = 1;
}
