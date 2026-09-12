import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'Failed to load configuration';
    process.stderr.write(`jfvrc: ${message}\n`);
    process.exit(1);
  }

  const { app } = buildApp({
    config,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      app.log.info({ signal }, 'shutting down');
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { port: config.port, host: config.host, configured: config.configured },
      'jfvrc listening',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start server');
    process.exit(1);
  }
}

void main();
