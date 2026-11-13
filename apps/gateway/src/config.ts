export function readConfig(env: NodeJS.ProcessEnv) {
  const port = env.GATEWAY_PORT ?? '3001';
  const host = env.GATEWAY_HOST ?? '127.0.0.1';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('GATEWAY_PORT must be an integer from 1 to 65535');
  }
  if (!/^[a-zA-Z0-9.:-]{1,253}$/.test(host)) {
    throw new Error('GATEWAY_HOST must be a hostname or IP address');
  }
  return { host, port: Number(port) };
}
