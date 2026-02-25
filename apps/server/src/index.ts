import { createServer } from './server.js';

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
