import { ConfigError, loadConfig } from '@wf/shared';
import { buildServer } from '../server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const app = await buildServer({ config });

  // PM2 and Docker both stop processes with a signal; close connections and
  // in-flight requests rather than dropping them.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

await main();
