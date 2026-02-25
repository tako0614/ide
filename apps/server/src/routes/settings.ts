import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { createHttpError, handleError } from '../utils/error.js';
import { PORT, BASIC_AUTH_USER, BASIC_AUTH_PASSWORD, SETTINGS_FILE } from '../config.js';

interface Settings {
  port: number;
  basicAuthEnabled: boolean;
  basicAuthUser: string;
  basicAuthPassword: string;
}

// Load settings from file or return defaults
async function loadSettings(): Promise<Settings> {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    return JSON.parse(data) as Settings;
  } catch {
    // Return defaults from environment or hardcoded defaults
    return {
      port: PORT,
      basicAuthEnabled: Boolean(BASIC_AUTH_USER && BASIC_AUTH_PASSWORD),
      basicAuthUser: BASIC_AUTH_USER || '',
      basicAuthPassword: BASIC_AUTH_PASSWORD || ''
    };
  }
}

// Save settings to file
async function saveSettings(settings: Settings): Promise<void> {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

export function createSettingsRouter() {
  const router = new Hono();

  // GET /api/settings - Get current settings
  router.get('/', async (c) => {
    try {
      const settings = await loadSettings();

      // Don't send password to client if it exists (for security)
      // Instead, send a flag indicating if password is set
      return c.json({
        port: settings.port,
        basicAuthEnabled: settings.basicAuthEnabled,
        basicAuthUser: settings.basicAuthUser,
        basicAuthPassword: settings.basicAuthPassword ? '••••••••••••' : ''
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // POST /api/settings - Update settings
  router.post('/', async (c) => {
    try {
      const body = await c.req.json() as Settings;

      // Validate settings
      if (!body.port || body.port < 1024 || body.port > 65535) {
        throw createHttpError('Port must be between 1024 and 65535', 400);
      }

      if (body.basicAuthEnabled) {
        if (!body.basicAuthUser || !body.basicAuthPassword) {
          throw createHttpError('Username and password are required when Basic Auth is enabled', 400);
        }
        if (body.basicAuthPassword.length < 12 && body.basicAuthPassword !== '••••••••••••') {
          throw createHttpError('Password must be at least 12 characters', 400);
        }
      }

      // Load current settings to preserve password if placeholder is sent
      const currentSettings = await loadSettings();
      const newSettings: Settings = {
        port: body.port,
        basicAuthEnabled: body.basicAuthEnabled,
        basicAuthUser: body.basicAuthUser,
        // If password is placeholder, keep current password
        basicAuthPassword: body.basicAuthPassword === '••••••••••••'
          ? currentSettings.basicAuthPassword
          : body.basicAuthPassword
      };

      // Save settings
      await saveSettings(newSettings);

      // Update environment variables for current process
      process.env.PORT = String(newSettings.port);
      if (newSettings.basicAuthEnabled) {
        process.env.BASIC_AUTH_USER = newSettings.basicAuthUser;
        process.env.BASIC_AUTH_PASSWORD = newSettings.basicAuthPassword;
      } else {
        delete process.env.BASIC_AUTH_USER;
        delete process.env.BASIC_AUTH_PASSWORD;
      }

      // Return success - client should restart server
      return c.json({
        success: true,
        message: 'Settings saved. Server restart required.',
        requiresRestart: true
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return router;
}
