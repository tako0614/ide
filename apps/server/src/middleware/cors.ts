import { type MiddlewareHandler } from 'hono';
import { CORS_ORIGIN, NODE_ENV } from '../config.js';

export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  if (CORS_ORIGIN) {
    c.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  } else if (NODE_ENV === 'development') {
    c.header('Access-Control-Allow-Origin', '*');
  }
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
};
