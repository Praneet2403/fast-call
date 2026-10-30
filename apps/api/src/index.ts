import { createSql, migrate, RequestRepo } from '@fast-call/db';
import { loadConfig } from './config.js';
import { createDispatchQueue } from './queue.js';
import { buildServer } from './server.js';
import { FleetStore } from './store.js';

const config = loadConfig();
const store = new FleetStore(config.redisUrl, config.heartbeatTtlSec);
await store.connect();

const sql = createSql();
await migrate(sql);
const queue = createDispatchQueue(config.redisUrl);

const app = await buildServer(config, { store, requests: new RequestRepo(sql), queue });
await app.listen({ port: config.port, host: config.host });

async function shutdown() {
  await app.close();
  await queue.close();
  await store.close();
  await sql.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
