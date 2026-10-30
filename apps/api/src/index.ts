import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { FleetStore } from './store.js';

const config = loadConfig();
const store = new FleetStore(config.redisUrl, config.heartbeatTtlSec);
await store.connect();

const app = await buildServer(config, store);
await app.listen({ port: config.port, host: config.host });

async function shutdown() {
  await app.close();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
