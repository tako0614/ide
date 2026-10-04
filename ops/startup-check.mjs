#!/usr/bin/env node
/** Required-name check only. Never prints, saves, or supplies environment values. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkStartupConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const cors = env.CORS_ORIGIN;
  const corsConfigured = typeof cors === 'string' && cors.trim().length > 0;
  return { production, corsConfigured, missing: production && !corsConfigured ? ['CORS_ORIGIN'] : [] };
}

class MissingStartupConfiguration extends Error {
  constructor() {
    super('CORS_ORIGIN must be set in production');
  }
}

export function assertStartupConfiguration(env = process.env) {
  const summary = checkStartupConfiguration(env);
  if (summary.missing.length) throw new MissingStartupConfiguration();
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Unexpected arguments');
    process.stdout.write(JSON.stringify(assertStartupConfiguration()) + '\n');
  } catch (error) {
    process.stderr.write(error instanceof MissingStartupConfiguration
      ? 'Startup configuration refused: CORS_ORIGIN must be set in production\n'
      : 'Startup configuration check failed\n');
    process.exitCode = 1;
  }
}
