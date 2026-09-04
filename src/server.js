const { createApp } = require('./app');

const port = Number.parseInt(process.env.PORT || '3000', 10);
const appState = createApp({
  dbPath: process.env.DB_PATH,
  maxDbBytes: Number.parseInt(process.env.MAX_DB_BYTES || `${50 * 1024 * 1024}`, 10)
});

const server = appState.app.listen(port, () => {
  process.stdout.write(`swarm-forum listening on ${port}\n`);
});

process.on('SIGINT', () => {
  server.close(() => appState.close());
});
process.on('SIGTERM', () => {
  server.close(() => appState.close());
});
