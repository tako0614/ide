import os from 'node:os';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = process.env.DEFAULT_ROOT || os.homedir();
export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '0.0.0.0';
export const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
export const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;
export const CORS_ORIGIN = process.env.CORS_ORIGIN;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);
export const TERMINAL_BUFFER_LIMIT = Number(process.env.TERMINAL_BUFFER_LIMIT || 50000);
export const TERMINAL_IDLE_TIMEOUT_MS = Number(process.env.TERMINAL_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
export const WS_RATE_LIMIT_WINDOW_MS = 1000;
export const WS_RATE_LIMIT_MAX_MESSAGES = 100;
export const MAX_REQUEST_BODY_SIZE = Number(process.env.MAX_REQUEST_BODY_SIZE || 1024 * 1024); // 1MB default
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true'; // Only trust proxy headers if explicitly enabled

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const distDir = path.resolve(__dirname, '..', '..', 'web', 'dist');
export const hasStatic = fsSync.existsSync(distDir);
export const dataDir = path.resolve(__dirname, '..', '..', 'data');
export const dbPath = process.env.DB_PATH || path.join(dataDir, 'deck-ide.db');

// Validate critical configuration
if (NODE_ENV === 'production') {
  if (!CORS_ORIGIN) {
    console.error('CRITICAL: CORS_ORIGIN must be set in production!');
    process.exit(1);
  }

  // Validate password strength in production
  if (BASIC_AUTH_PASSWORD && BASIC_AUTH_PASSWORD.length < 12) {
    console.error('CRITICAL: BASIC_AUTH_PASSWORD must be at least 12 characters in production!');
    process.exit(1);
  }

  // Warn if no authentication is configured
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
    console.warn('WARNING: No authentication configured! API is publicly accessible.');
  }
}

// Validate numeric configuration values
if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  console.error('CRITICAL: Invalid PORT value');
  process.exit(1);
}

if (!Number.isFinite(MAX_FILE_SIZE) || MAX_FILE_SIZE < 1024) {
  console.error('CRITICAL: Invalid MAX_FILE_SIZE value');
  process.exit(1);
}

// Ensure data directory exists
fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
