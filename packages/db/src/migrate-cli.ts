import { createSql, migrate } from './client.js';

const sql = createSql();
await migrate(sql);
console.log('schema applied');
await sql.end();
