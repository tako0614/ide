#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI arguments
const args = process.argv.slice(2);
const options = {
  port: 8787,
  host: '0.0.0.0',
  open: true,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '--port' || arg === '-p') && args[i + 1]) {
    options.port = parseInt(args[i + 1], 10);
    i++;
  } else if (arg === '--host' && args[i + 1]) {
    options.host = args[i + 1];
    i++;
  } else if (arg === '--no-open') {
    options.open = false;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Deck IDE - Browser-based IDE

Usage:
  deckide [options]

Options:
  -p, --port <port>  Port to listen on (default: 8787)
  --host <host>      Host to bind to (default: 0.0.0.0)
  --no-open          Don't open browser automatically
  -h, --help         Show this help message
  -v, --version      Show version
`);
    process.exit(0);
  } else if (arg === '--version' || arg === '-v') {
    const pkg = await import(path.join(__dirname, '..', 'package.json'), { with: { type: 'json' } });
    console.log(pkg.default.version);
    process.exit(0);
  }
}

// Set data directory to ~/.deckide/
const dataDir = path.join(os.homedir(), '.deckide');
process.env.DECKIDE_DATA_DIR = dataDir;
process.env.PORT = String(options.port);
process.env.HOST = options.host;

// Import and start the server
const serverPath = path.join(__dirname, '..', 'apps', 'server', 'dist', 'index.js');
const { createServer } = await import(path.join(__dirname, '..', 'apps', 'server', 'dist', 'server.js'));

const server = await createServer();

// Open browser after server starts
if (options.open) {
  const url = `http://localhost:${options.port}`;
  setTimeout(() => {
    try {
      const platform = process.platform;
      if (platform === 'darwin') {
        execSync(`open ${url}`);
      } else if (platform === 'win32') {
        execSync(`start ${url}`);
      } else {
        execSync(`xdg-open ${url}`);
      }
    } catch {
      // Silently fail if browser can't be opened
    }
  }, 500);
}
