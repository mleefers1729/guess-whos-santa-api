import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createRepository, migrate } from './db.js';
import { createLocalStorage, createS3Storage } from './photos.js';

const config = readConfig();
const { caFile, ...databaseConfig } = config.database ?? {};
const pool = config.database ? new pg.Pool({
  ...databaseConfig,
  ssl: caFile ? { ca: await readFile(caFile, 'utf8'), rejectUnauthorized: true } : false,
  max: 10,
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
  idleTimeoutMillis: 30_000,
}) : undefined;
pool?.on('error', (error) => console.error('Idle database connection failed', error));

let repository;
let cleanupTimer;
if (pool) {
  await migrate(pool);
  repository = createRepository(pool, { retentionDays: config.photoRetentionDays });
  const cleanup = () => repository.deleteExpiredParties(config.photoRetentionDays)
    .catch((error) => console.error('Expired party cleanup failed', error));
  await cleanup();
  cleanupTimer = setInterval(cleanup, 60 * 60 * 1000).unref();
} else {
  console.warn('No DATABASE_HOST configured; party routes are disabled.');
}

const storage = config.media.kind === 's3'
  ? createS3Storage(config.media)
  : createLocalStorage({ ...config.media, secret: config.media.secret ?? randomBytes(32).toString('hex') });

const app = await createApp(config, {
  checkDatabase: pool ? () => pool.query('SELECT 1') : undefined,
  repository,
  storage,
});
const server = app.listen(config.port, config.host, () => {
  console.log(`Guess Who's Santa API listening on http://${config.host}:${config.port}`);
});

server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

function shutdown() {
  clearInterval(cleanupTimer);
  server.close(async () => {
    await pool?.end();
    process.exitCode = 0;
  });
  setTimeout(() => {
    server.closeAllConnections();
  }, 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
