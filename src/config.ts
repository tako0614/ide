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
  host?: string;
  authEnabled?: boolean;
  authUser?: string;
  authPasswordHash?: string;
  passwordHash?: string;
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

/**
 * True when the bind address only accepts connections originating on this
 * machine. Anything else (0.0.0.0, ::, a LAN IP, an empty value — which Node
 * treats as "all interfaces") reaches the API from the network.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false; // empty => Node binds every interface
  if (h === 'localhost') return true;
  if (h === '::1' || h === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export const DEFAULT_ROOT = process.env.DEFAULT_ROOT || os.homedir();
export const PORT = parseIntEnv(process.env.PORT ?? fileSettings.port, 8787);
// Loopback by default: the API can create workspaces at arbitrary paths and
// spawn terminals running arbitrary commands, so binding every interface must
// be a deliberate act, not the default.
export const HOST = process.env.HOST || fileSettings.host || '127.0.0.1';
// Escape hatch for deployments that terminate auth elsewhere (reverse proxy,
// container network policy). Opting out of the auth requirement below is the
// operator's explicit decision.
export const ALLOW_INSECURE_HOST = process.env.DECKIDE_ALLOW_INSECURE_HOST === 'true';
// Hostnames this server may be addressed by, beyond the always-safe set
// (localhost and IP literals). Needed only when reaching the API through a
// DNS name — a reverse proxy or a custom LAN hostname. Comma-separated.
export const ALLOWED_HOSTS = (process.env.DECKIDE_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
// Legacy names are accepted only as credential input during migration. HTTP Basic
// authorization is never enabled by these variables.
export const AUTH_ENV_USER = process.env.DECKIDE_AUTH_USER ?? process.env.BASIC_AUTH_USER;
export const AUTH_ENV_PASSWORD = process.env.DECKIDE_AUTH_PASSWORD ?? process.env.BASIC_AUTH_PASSWORD;
const fileAuthEnabled = fileSettings.authEnabled ?? fileSettings.basicAuthEnabled ?? false;
const fileAuthUser = fileSettings.authUser ?? fileSettings.basicAuthUser;
const fileHasVerifier = Boolean(fileSettings.authPasswordHash || fileSettings.passwordHash || fileSettings.basicAuthPassword);
export const AUTH_CONFIGURED = Boolean((AUTH_ENV_USER && AUTH_ENV_PASSWORD) ||
  (fileAuthEnabled && fileAuthUser && fileHasVerifier));
export const CORS_ORIGIN = process.env.CORS_ORIGIN;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const MAX_FILE_SIZE = parseIntEnv(process.env.MAX_FILE_SIZE, 10 * 1024 * 1024);
export const TERMINAL_BUFFER_LIMIT = parseIntEnv(process.env.TERMINAL_BUFFER_LIMIT, 500_000);
// Live terminal output is batched per terminal into one WebSocket frame per
// interval. 0 flushes on the next event-loop turn.
export const TERMINAL_OUTPUT_COALESCE_MS = Math.min(100, Math.max(0,
  parseIntEnv(process.env.TERMINAL_OUTPUT_COALESCE_MS, 16)));
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
if (AUTH_ENV_USER !== undefined || AUTH_ENV_PASSWORD !== undefined) {
  if (!AUTH_ENV_USER || !AUTH_ENV_USER.trim() || AUTH_ENV_USER.length > 128 || !AUTH_ENV_PASSWORD ||
      AUTH_ENV_PASSWORD.length < 12 || Buffer.byteLength(AUTH_ENV_PASSWORD) > 1024) {
    console.error('CRITICAL: auth environment credentials require a nonblank user (max 128 characters) and a password of 12 to 1024 bytes.');
    process.exit(1);
  }
}
if (NODE_ENV === 'production') {
  if (!CORS_ORIGIN) {
    console.error('CRITICAL: CORS_ORIGIN must be set in production!');
    process.exit(1);
  }

  // Warn if no authentication is configured
  if (!AUTH_CONFIGURED) {
    console.warn('WARNING: No authentication configured! API is publicly accessible.');
  }
}

// Refuse to serve an unauthenticated API to the network. The terminal API
// executes caller-supplied commands as this OS user, so a network-reachable
// bind address without credentials is remote code execution for anyone who can
// reach the port.
if (!isLoopbackHost(HOST) && !AUTH_CONFIGURED && !ALLOW_INSECURE_HOST) {
  console.error(`CRITICAL: refusing to bind ${HOST || '0.0.0.0'} without authentication.`);
  console.error('The API can spawn terminals running arbitrary commands as this user.');
  console.error('Fix with one of:');
  console.error('  deckide auth on <user> <password>   # enable session sign-in, then retry');
  console.error('  deckide config set host 127.0.0.1   # listen on loopback only (default)');
  console.error('  DECKIDE_ALLOW_INSECURE_HOST=true    # only behind a trusted proxy/network');
  process.exit(1);
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

