import { Redis } from 'ioredis';
import { createSql, migrate, RequestRepo } from '@fast-call/db';
import { AGENT_COMMANDS_CHANNEL } from '@fast-call/shared';
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

// A Redis connection in subscribe mode can't run other commands, so it gets its own.
const subscriber = new Redis(config.redisUrl);
await subscriber.subscribe(AGENT_COMMANDS_CHANNEL);
const commands = {
  onCommand(handler: (raw: string) => void) {
    subscriber.on('message', (_channel: string, raw: string) => handler(raw));
  },
};

const app = await buildServer(config, { store, requests: new RequestRepo(sql), queue, commands });
await app.listen({ port: config.port, host: config.host });

async function shutdown() {
  await app.close();
  await queue.close();
  subscriber.disconnect();
  await store.close();
  await sql.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
