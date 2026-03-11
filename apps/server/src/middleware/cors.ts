import { type MiddlewareHandler } from 'hono';
import { CORS_ORIGIN, NODE_ENV, PORT } from '../config.js';

const DEV_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  `http://localhost:${PORT}`,
];

export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  if (CORS_ORIGIN) {
    c.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  } else if (NODE_ENV === 'development') {
    const origin = c.req.header('origin');
    if (origin && DEV_ALLOWED_ORIGINS.includes(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
    } else {
      c.header('Access-Control-Allow-Origin', `http://localhost:${PORT}`);
    }
  }
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
};
