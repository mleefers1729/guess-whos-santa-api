import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = await createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`Guess Who's Santa API listening on http://${config.host}:${config.port}`);
});

server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => {
    process.exitCode = 0;
  });
  setTimeout(() => {
    server.closeAllConnections();
  }, 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
