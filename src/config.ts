import os from 'node:os';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// When running as a global CLI (`deckide`), DECKIDE_DATA_DIR is set to ~/.deckide/
const globalDataDir = process.env.DECKIDE_DATA_DIR;
// New flat structure: dist/ is at root, settings.json is at root
export const SETTINGS_FILE = globalDataDir
  ? path.join(globalDataDir, 'settings.json')
  : path.join(__dirname, '..', 'settings.json');

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

function parseIntEnv(val: string | number | undefined, defaultVal: number): number {
  if (typeof val === 'number') return Number.isFinite(val) ? Math.floor(val) : defaultVal;
  const n = parseInt(val ?? '', 10);
  return Number.isFinite(n) ? n : defaultVal;
}

export const DEFAULT_ROOT = process.env.DEFAULT_ROOT || os.homedir();
export const PORT = parseIntEnv(process.env.PORT ?? fileSettings.port, 8787);
export const HOST = process.env.HOST || '0.0.0.0';
export const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || (fileSettings.basicAuthEnabled ? fileSettings.basicAuthUser : undefined);
export const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || (fileSettings.basicAuthEnabled ? fileSettings.basicAuthPassword : undefined);
export const CORS_ORIGIN = process.env.CORS_ORIGIN;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const MAX_FILE_SIZE = parseIntEnv(process.env.MAX_FILE_SIZE, 10 * 1024 * 1024);
export const TERMINAL_BUFFER_LIMIT = parseIntEnv(process.env.TERMINAL_BUFFER_LIMIT, 500_000);
export const MAX_REQUEST_BODY_SIZE = parseIntEnv(process.env.MAX_REQUEST_BODY_SIZE, 1024 * 1024); // 1MB default
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true'; // Only trust proxy headers if explicitly enabled

// --- Agent browser WebRTC streaming (A1: direct Xvfb capture → ffmpeg → werift) ---
// Master switch. 'false' (default) keeps the JPEG screencast path and never even
// imports werift. 'true'/'auto' advertise the WebRTC capability; the client still
// falls back to JPEG on any failure.
const webrtcFlag = (process.env.AGENT_BROWSER_WEBRTC || 'false').toLowerCase();
export const AGENT_BROWSER_WEBRTC = webrtcFlag === 'true' || webrtcFlag === 'auto';
// Video codec for the encoded stream. Only 'vp8' is wired today; 'vp9'/'h264'
// are accepted for forward-compat and validated in the relay.
export const AGENT_BROWSER_WEBRTC_CODEC = (process.env.AGENT_BROWSER_WEBRTC_CODEC || 'vp8').toLowerCase();
// Target video bitrate passed to the encoder (ffmpeg -b:v syntax, e.g. '3M').
export const AGENT_BROWSER_WEBRTC_BITRATE = process.env.AGENT_BROWSER_WEBRTC_BITRATE || '3M';
export const AGENT_BROWSER_WEBRTC_FPS = parseIntEnv(process.env.AGENT_BROWSER_WEBRTC_FPS, 30);
// Optional explicit X display to capture (e.g. ':99'). When unset the relay
// discovers it from the running Chrome process environment.
export const AGENT_BROWSER_DISPLAY = process.env.AGENT_BROWSER_DISPLAY || '';
// Optional ICE servers as JSON (e.g. '[{"urls":"stun:stun.l.google.com:19302"}]').
// Empty = host candidates only, which is correct for same-host / LAN.
export const AGENT_BROWSER_WEBRTC_ICE_SERVERS = process.env.AGENT_BROWSER_WEBRTC_ICE_SERVERS || '';

// --- Shared-browser maintenance ---
// CDP port the shared agent browser listens on (must match agent-browser's).
export const AGENT_BROWSER_CDP_PORT = parseIntEnv(process.env.AGENT_BROWSER_CDP_PORT, 9222);
// Reap leaked chrome-devtools-mcp server stacks when one agent accumulates too
// many (the observed leak). On by default; set 'false' to disable.
export const AGENT_BROWSER_REAP_MCP = (process.env.AGENT_BROWSER_REAP_MCP || 'true').toLowerCase() !== 'false';
// Max chrome-devtools-mcp stacks a single agent may keep before old extras are reaped.
export const AGENT_BROWSER_MAX_MCP_PER_AGENT = parseIntEnv(process.env.AGENT_BROWSER_MAX_MCP_PER_AGENT, 3);
// Extra stacks must be older than this before being reaped (spares restart bursts).
export const AGENT_BROWSER_MCP_IDLE_MS = parseIntEnv(process.env.AGENT_BROWSER_MCP_IDLE_MS, 600_000);

// Flat structure: dist/ and web/dist/ are siblings at project root
export const distDir = path.resolve(__dirname, '..', 'web', 'dist');
export const hasStatic = fsSync.existsSync(distDir);

const localDataDir = path.resolve(__dirname, '..', 'data');
export const dataDir = globalDataDir || localDataDir;
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

