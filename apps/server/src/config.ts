import os from 'node:os';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');

// Load settings from file if exists
interface Settings {
  port?: number;
  basicAuthEnabled?: boolean;
  basicAuthUser?: string;
  basicAuthPassword?: string;
}

let fileSettings: Settings = {};
try {
  const settingsData = fsSync.readFileSync(SETTINGS_FILE, 'utf-8');
  fileSettings = JSON.parse(settingsData) as Settings;
  console.log('[CONFIG] Loaded settings from file');
} catch {
  // No settings file, use environment variables
}

export const DEFAULT_ROOT = process.env.DEFAULT_ROOT || os.homedir();
export const PORT = Number(process.env.PORT || fileSettings.port || 8787);
export const HOST = process.env.HOST || '0.0.0.0';
export const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || (fileSettings.basicAuthEnabled ? fileSettings.basicAuthUser : undefined);
export const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || (fileSettings.basicAuthEnabled ? fileSettings.basicAuthPassword : undefined);
export const CORS_ORIGIN = process.env.CORS_ORIGIN;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);
export const TERMINAL_BUFFER_LIMIT = Number(process.env.TERMINAL_BUFFER_LIMIT || 50000);
export const MAX_REQUEST_BODY_SIZE = Number(process.env.MAX_REQUEST_BODY_SIZE || 1024 * 1024); // 1MB default
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true'; // Only trust proxy headers if explicitly enabled
export const MAX_CONCURRENT_AGENTS = Number(process.env.MAX_CONCURRENT_AGENTS || 5);
export const MAX_AGENT_COST_USD = Number(process.env.MAX_AGENT_COST_USD || 5);
export const MAX_AGENT_MESSAGES = Number(process.env.MAX_AGENT_MESSAGES || 500);
export const MAX_AGENT_PROMPT_LENGTH = Number(process.env.MAX_AGENT_PROMPT_LENGTH || 10000);

// In packaged app: server is at app.asar.unpacked/server/, web is at app.asar.unpacked/web/dist/
// In development: server is at apps/server/dist/, web is at apps/web/dist/
const packagedDistDir = path.resolve(__dirname, '..', 'web', 'dist');
const devDistDir = path.resolve(__dirname, '..', '..', 'web', 'dist');
export const distDir = fsSync.existsSync(packagedDistDir) ? packagedDistDir : devDistDir;
export const hasStatic = fsSync.existsSync(distDir);

const packagedDataDir = path.resolve(__dirname, '..', 'data');
const devDataDir = path.resolve(__dirname, '..', '..', 'data');
export const dataDir = fsSync.existsSync(path.dirname(packagedDataDir)) && !fsSync.existsSync(devDataDir) ? packagedDataDir : devDataDir;
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
