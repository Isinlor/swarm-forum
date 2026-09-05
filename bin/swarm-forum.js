#!/usr/bin/env node
'use strict';

const { start } = require('../src/server');

const server = start();
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
