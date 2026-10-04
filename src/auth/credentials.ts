import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ALLOW_INSECURE_HOST, AUTH_ENV_PASSWORD, AUTH_ENV_USER, HOST, PORT, SETTINGS_FILE, isLoopbackHost } from '../config.js';
import { hashPassword, isPasswordHash } from './password.js';

type FileSettings = Record<string, unknown>;
type AuthState = { enabled: boolean; user: string; hash: string; port: number };
let state: AuthState = { enabled: false, user: '', hash: '', port: PORT };
let initialized = false;
let writeQueue: Promise<unknown> = Promise.resolve();

async function readFileSettings(): Promise<FileSettings> {
  try {
    const stat = await fs.lstat(SETTINGS_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings must be a regular file');
    const parsed: unknown = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings file');
    return parsed as FileSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function atomicWrite(settings: FileSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  const temp = `${SETTINGS_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(settings, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await fs.rename(temp, SETTINGS_FILE);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function normalized(settings: FileSettings): FileSettings {
  const copy = { ...settings };
  delete copy.basicAuthEnabled;
  delete copy.basicAuthUser;
  delete copy.basicAuthPassword;
  delete copy.passwordHash;
  return copy;
}

export async function initializeCredentials(): Promise<void> {
  const settings = await readFileSettings();
  const user = typeof settings.authUser === 'string' ? settings.authUser :
    typeof settings.basicAuthUser === 'string' ? settings.basicAuthUser : '';
  let hash = typeof settings.authPasswordHash === 'string' ? settings.authPasswordHash : '';
  if (!hash && typeof settings.passwordHash === 'string') {
    if (!isPasswordHash(settings.passwordHash)) throw new Error('Invalid legacy password hash');
    hash = settings.passwordHash;
  }
  const enabled = settings.authEnabled === true || (settings.authEnabled === undefined && settings.basicAuthEnabled === true);
  if (!hash && typeof settings.basicAuthPassword === 'string' && settings.basicAuthPassword) {
    hash = await hashPassword(settings.basicAuthPassword);
  }
  if (hash && !isPasswordHash(hash)) throw new Error('Invalid stored auth password hash');
  if (enabled && (!user || !hash)) throw new Error('Authentication enabled without credentials');
  if ('basicAuthPassword' in settings || 'basicAuthEnabled' in settings || 'basicAuthUser' in settings || 'passwordHash' in settings) {
    await atomicWrite({ ...normalized(settings), authEnabled: enabled, authUser: user, authPasswordHash: hash });
  }
  if (AUTH_ENV_USER || AUTH_ENV_PASSWORD) {
    if (!AUTH_ENV_USER || !AUTH_ENV_PASSWORD) throw new Error('Both auth environment credentials are required');
    state = { enabled: true, user: AUTH_ENV_USER, hash: await hashPassword(AUTH_ENV_PASSWORD), port: PORT };
  } else {
    state = { enabled, user, hash, port: PORT };
  }
  initialized = true;
}

export function getCredentials(): Readonly<AuthState> {
  if (!initialized) throw new Error('Auth credentials not initialized');
  return state;
}

export type SettingsUpdate = { port?: number; authEnabled?: boolean; authUser?: string; authPassword?: string };

export function updateCredentials(input: SettingsUpdate, onCommit: () => void = () => {}): Promise<Readonly<AuthState>> {
  const work = async () => {
    if (!initialized) throw new Error('Auth credentials not initialized');
    if (AUTH_ENV_USER || AUTH_ENV_PASSWORD) throw new Error('Authentication is controlled by environment variables');
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535)) {
      throw new Error('Port must be between 1024 and 65535');
    }
    if (input.authEnabled !== undefined && typeof input.authEnabled !== 'boolean') throw new Error('Invalid authEnabled');
    if (input.authUser !== undefined && (typeof input.authUser !== 'string' || !input.authUser.trim() || input.authUser.length > 128)) {
      throw new Error('Invalid authUser');
    }
    if (input.authPassword !== undefined && typeof input.authPassword !== 'string') throw new Error('Invalid authPassword');
    let hash = state.hash;
    if (input.authPassword) {
      if (input.authPassword.length < 12 || Buffer.byteLength(input.authPassword) > 1024) throw new Error('Password must be 12 to 1024 bytes');
      hash = await hashPassword(input.authPassword);
    }
    const next: AuthState = {
      port: input.port ?? state.port,
      enabled: input.authEnabled ?? state.enabled,
      user: input.authUser ?? state.user,
      hash,
    };
    if (next.enabled && (!next.user || !next.hash)) throw new Error('Username and password are required');
    if (!next.enabled && !isLoopbackHost(HOST) && !ALLOW_INSECURE_HOST) {
      throw new Error('Authentication cannot be disabled on a network bind');
    }
    const existing = await readFileSettings();
    await atomicWrite({ ...normalized(existing), port: next.port, authEnabled: next.enabled,
      authUser: next.user, authPasswordHash: next.hash });
    const authChanged = state.enabled !== next.enabled || state.user !== next.user || state.hash !== next.hash;
    state = next;
    if (authChanged) onCommit();
    return state;
  };
  const next = writeQueue.then(work, work);
  writeQueue = next.catch(() => undefined);
  return next;
}
