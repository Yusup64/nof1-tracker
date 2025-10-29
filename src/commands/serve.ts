import path from 'path';
import { initializeServices } from '../utils/command-helpers';
import { handleError } from '../utils/command-helpers';
import { startApiServer } from '../server/api-server';

export interface ServeCommandOptions {
  port?: number;
  host?: string;
}

export async function handleServeCommand(options: ServeCommandOptions): Promise<void> {
  try {
    const services = initializeServices(true);
    const port = options.port ?? parseInt(process.env.API_PORT || '8080', 10);
    const host = options.host ?? (process.env.API_HOST || '0.0.0.0');
    const staticDir = process.env.DASHBOARD_DIR
      ? path.resolve(process.env.DASHBOARD_DIR)
      : path.join(process.cwd(), 'dashboard');

    const apiServer = await startApiServer({
      services,
      port,
      host,
      staticDir
    });

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log(`\n👋 Received ${signal}, shutting down API server...`);
      try {
        await apiServer.close();
        console.log('✅ API server stopped');
      } catch (error) {
        console.error('❌ Failed to stop API server:', error instanceof Error ? error.message : error);
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process alive until shutdown is triggered
    await new Promise<void>(() => { /* noop */ });
  } catch (error) {
    handleError(error, 'Failed to start API server');
  }
}
