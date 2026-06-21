import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { TerminalSession } from '../types.js';
import { alignToUtf8Start, alignToUtf8End } from '../utils/utf8.js';
import {
  BASIC_AUTH_PASSWORD,
  BASIC_AUTH_USER,
  CORS_ORIGIN,
  NODE_ENV,
  PORT,
  TRUST_PROXY,
} from '../config.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, unknown>;
type RequestId = string | number | null;

type OAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  issuedAt: number;
};

type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
};

type AccessToken = {
  token: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
};

type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonRecord;
  annotations?: JsonRecord;
  handler: (args: JsonRecord, ctx: ToolContext) => Promise<unknown> | unknown;
};

type ToolContext = {
  resource: string;
};

type CreateMcpRouterOptions = {
  apiFetch: (request: Request) => Promise<Response>;
  terminals: Map<string, TerminalSession>;
};

class ToolExecutionError extends Error {
  status?: number;
  data?: unknown;

  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'ToolExecutionError';
    this.status = status;
    this.data = data;
  }
}

const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_SCOPE = 'deckide:all';
const clients = new Map<string, OAuthClient>();
const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();

setInterval(() => {
  const now = Date.now();
  for (const [code, record] of authorizationCodes.entries()) {
    if (record.expiresAt <= now) authorizationCodes.delete(code);
  }
  for (const [token, record] of accessTokens.entries()) {
    if (record.expiresAt <= now) accessTokens.delete(token);
  }
}, 60_000).unref();

function jsonRpcResult(id: RequestId, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: RequestId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function isObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: JsonRecord, key: string, required = true): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new ToolExecutionError(`${key} is required`, 400);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ToolExecutionError(`${key} must be a string`, 400);
  }
  return value;
}

function booleanArg(args: JsonRecord, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolExecutionError(`${key} must be a boolean`, 400);
  }
  return value;
}

function numberArg(args: JsonRecord, key: string, required = true): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new ToolExecutionError(`${key} is required`, 400);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolExecutionError(`${key} must be a finite number`, 400);
  }
  return value;
}

function stringArrayArg(args: JsonRecord, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolExecutionError(`${key} must be an array of strings`, 400);
  }
  return value;
}

function objectArg(args: JsonRecord, key: string): JsonRecord | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) {
    throw new ToolExecutionError(`${key} must be an object`, 400);
  }
  return value;
}

function schema(properties: JsonRecord, required: string[] = [], additionalProperties = false): JsonRecord {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
  };
}

function emptySchema(): JsonRecord {
  return { type: 'object', additionalProperties: false };
}

function getBaseUrl(c: Context): string {
  const requestUrl = new URL(c.req.url);
  const forwardedProto = TRUST_PROXY ? c.req.header('x-forwarded-proto') : undefined;
  const forwardedHost = TRUST_PROXY ? c.req.header('x-forwarded-host') : undefined;
  const proto = (forwardedProto || requestUrl.protocol.replace(':', '')).split(',')[0].trim();
  const host = (forwardedHost || c.req.header('host') || requestUrl.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

function getMcpResource(c: Context): string {
  return `${getBaseUrl(c)}/mcp`;
}

function getProtectedResourceMetadataUrl(c: Context): string {
  return `${getBaseUrl(c)}/.well-known/oauth-protected-resource/mcp`;
}

function bearerChallenge(c: Context, error?: string): string {
  const params = [
    `resource_metadata="${getProtectedResourceMetadataUrl(c)}"`,
    `scope="${OAUTH_SCOPE}"`,
  ];
  if (error) params.unshift(`error="${error}"`);
  return `Bearer ${params.join(', ')}`;
}

function parseBearerToken(c: Context): string | null {
  const auth = c.req.header('authorization');
  if (!auth) return null;
  const [scheme, token] = auth.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function validateAccessToken(c: Context): AccessToken | null {
  const token = parseBearerToken(c);
  if (!token) return null;

  const record = accessTokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    accessTokens.delete(token);
    return null;
  }

  if (record.resource !== getMcpResource(c) || !record.scopes.includes(OAUTH_SCOPE)) {
    return null;
  }

  return record;
}

function validRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    }
  } catch {
    return false;
  }
  return false;
}

function isKnownRedirectUri(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

function normalizeScopes(scopeValue: string | null): string[] {
  if (!scopeValue?.trim()) return [OAUTH_SCOPE];
  const scopes = scopeValue.split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return [OAUTH_SCOPE];
  if (scopes.some((scope) => scope !== OAUTH_SCOPE)) {
    throw new ToolExecutionError(`Unsupported scope. Supported scope: ${OAUTH_SCOPE}`, 400);
  }
  return scopes;
}

function hashCodeVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function redirectWithParams(redirectUri: string, params: Record<string, string>): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return Response.redirect(target.toString(), 302);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function readForm(c: Context): Promise<URLSearchParams> {
  const text = await c.req.text();
  return new URLSearchParams(text);
}

function renderConsentPage(params: URLSearchParams, client: OAuthClient): string {
  const hiddenInputs = Array.from(params.entries())
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('\n');
  const scope = params.get('scope') || OAUTH_SCOPE;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deck IDE OAuth</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; color: #111; background: #fff; }
    main { max-width: 680px; }
    code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 4px; }
    button { border: 1px solid #111; border-radius: 6px; background: #111; color: #fff; padding: 0.6rem 0.9rem; cursor: pointer; }
    button.secondary { background: #fff; color: #111; margin-left: 0.5rem; }
  </style>
</head>
<body>
  <main>
    <h1>Deck IDE MCP access</h1>
    <p><strong>${escapeHtml(client.clientName || client.clientId)}</strong> にDeck IDEのMCPツール使用を許可します。</p>
    <p>Scope: <code>${escapeHtml(scope)}</code></p>
    <p>許可すると、このクライアントはワークスペース、ファイル、デッキ、端末、Git、設定、サーバー操作をMCP経由で実行できます。</p>
    <form method="post" action="/oauth/authorize">
      ${hiddenInputs}
      <button type="submit" name="decision" value="approve">許可</button>
      <button class="secondary" type="submit" name="decision" value="deny">拒否</button>
    </form>
  </main>
</body>
</html>`;
}

function validateAuthorizationRequest(params: URLSearchParams, c: Context) {
  const responseType = params.get('response_type');
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const resource = params.get('resource') || getMcpResource(c);

  if (responseType !== 'code') throw new ToolExecutionError('response_type must be code', 400);
  if (!clientId) throw new ToolExecutionError('client_id is required', 400);
  if (!redirectUri) throw new ToolExecutionError('redirect_uri is required', 400);
  if (!codeChallenge) throw new ToolExecutionError('code_challenge is required', 400);
  if (codeChallengeMethod !== 'S256') throw new ToolExecutionError('code_challenge_method must be S256', 400);
  if (resource !== getMcpResource(c)) throw new ToolExecutionError('resource does not match this MCP server', 400);

  const client = clients.get(clientId);
  if (!client) throw new ToolExecutionError('Unknown client_id', 400);
  if (!isKnownRedirectUri(client, redirectUri)) {
    throw new ToolExecutionError('redirect_uri is not registered for this client', 400);
  }

  const scopes = normalizeScopes(params.get('scope'));
  return { client, clientId, redirectUri, codeChallenge, scopes, resource };
}

function basicAuthHeader(): string | undefined {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) return undefined;
  return `Basic ${Buffer.from(`${BASIC_AUTH_USER}:${BASIC_AUTH_PASSWORD}`).toString('base64')}`;
}

function appendQuery(path: string, query?: JsonRecord): string {
  if (!query) return path;
  const url = new URL(path, 'http://deckide.local');
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function apiJson(apiFetch: (request: Request) => Promise<Response>, method: string, path: string, body?: unknown): Promise<unknown> {
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  const auth = basicAuthHeader();
  if (auth) headers.set('Authorization', auth);

  let requestBody: string | undefined;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(body);
  }

  const response = await apiFetch(new Request(`http://deckide.local${path}`, {
    method,
    headers,
    body: requestBody,
  }));

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  } else if (response.status === 204) {
    data = { success: true, status: 204 };
  }

  if (!response.ok) {
    const message = isObject(data) && typeof data.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    throw new ToolExecutionError(message, response.status, data);
  }

  return data ?? { success: true, status: response.status };
}

function apiTool(
  apiFetch: (request: Request) => Promise<Response>,
  method: string,
  path: string | ((args: JsonRecord) => string),
  body?: (args: JsonRecord) => unknown
) {
  return (args: JsonRecord) => {
    const resolvedPath = typeof path === 'function' ? path(args) : path;
    return apiJson(apiFetch, method, resolvedPath, body ? body(args) : undefined);
  };
}

function terminalReadBuffer(terminals: Map<string, TerminalSession>, args: JsonRecord) {
  const terminalId = stringArg(args, 'terminalId');
  const maxBytesArg = numberArg(args, 'maxBytes', false);
  const offsetArg = numberArg(args, 'offset', false);
  const session = terminals.get(terminalId!);
  if (!session) throw new ToolExecutionError('Terminal not found', 404);

  const buffer = Buffer.concat(session.bufferChunks, session.bufferLength);
  const maxBytes = Math.min(Math.max(Math.floor(maxBytesArg ?? 50_000), 1), 200_000);
  let start = 0;
  let truncated = false;

  if (offsetArg !== undefined) {
    start = Math.floor(offsetArg) - session.bufferBase;
    if (start < 0) {
      start = 0;
      truncated = true;
    }
    if (start > buffer.length) start = buffer.length;
  } else if (buffer.length > maxBytes) {
    start = buffer.length - maxBytes;
    truncated = true;
  }

  const end = Math.min(buffer.length, start + maxBytes);

  // マルチバイト文字を途中で切らないよう、両端を UTF-8 文字境界に丸める。
  // （任意オフセットの切り出しで継続バイトだけが残ると文字化けするため。）
  const alignedStart = alignToUtf8Start(buffer, start);
  const alignedEnd = alignToUtf8End(buffer, end);
  const safeEnd = Math.max(alignedStart, alignedEnd);

  return {
    terminalId,
    bufferBase: session.bufferBase,
    bufferLength: session.bufferLength,
    returnedOffset: session.bufferBase + alignedStart,
    nextOffset: session.bufferBase + safeEnd,
    truncated,
    text: buffer.subarray(alignedStart, safeEnd).toString('utf8'),
  };
}

// 1回の write で PTY に流せる最大バイト数。WebSocket 経路（64KB/フレーム）と
// 揃え、巨大ペイロードでの一気書き込みを防ぐ。
const MAX_MCP_WRITE_BYTES = 1024 * 1024;

function terminalWrite(terminals: Map<string, TerminalSession>, args: JsonRecord) {
  const terminalId = stringArg(args, 'terminalId');
  const data = stringArg(args, 'data');
  const appendNewline = booleanArg(args, 'appendNewline') === true;
  const session = terminals.get(terminalId!);
  if (!session) throw new ToolExecutionError('Terminal not found', 404);
  const payload = appendNewline ? `${data}\n` : data!;
  if (Buffer.byteLength(payload, 'utf8') > MAX_MCP_WRITE_BYTES) {
    throw new ToolExecutionError(
      `data exceeds the maximum write size of ${MAX_MCP_WRITE_BYTES} bytes`,
      400
    );
  }
  session.write(payload);
  session.lastActive = Date.now();
  return { terminalId, bytesWritten: Buffer.byteLength(payload, 'utf8') };
}

function terminalResize(terminals: Map<string, TerminalSession>, args: JsonRecord) {
  // 注意: ブラウザクライアントが接続中の場合、そのクライアントの
  // ResizeObserver/fit が次のフレームでサイズを再設定するため、この
  // リサイズは一時的になる。クライアント未接続（ヘッドレス）の端末では
  // 指定サイズがそのまま維持される。
  const terminalId = stringArg(args, 'terminalId');
  const cols = numberArg(args, 'cols');
  const rows = numberArg(args, 'rows');
  const session = terminals.get(terminalId!);
  if (!session) throw new ToolExecutionError('Terminal not found', 404);
  // WebSocket 経路（MIN 1 / MAX 500）と同じ範囲でバリデーションする。
  if (!cols || !rows || cols < 1 || rows < 1 || cols > 500 || rows > 500) {
    throw new ToolExecutionError('cols and rows must be within a reasonable terminal size', 400);
  }
  session.resize(Math.floor(cols), Math.floor(rows));
  session.lastActive = Date.now();
  return { terminalId, cols: Math.floor(cols), rows: Math.floor(rows) };
}

function buildTools(options: CreateMcpRouterOptions): McpTool[] {
  const api = options.apiFetch;
  const idParam = { type: 'string' };
  const pathParam = { type: 'string' };
  const repoPathParam = { type: 'string', description: 'Optional path to a Git repo relative to the workspace root.' };
  const gitBody = (args: JsonRecord) => ({
    workspaceId: stringArg(args, 'workspaceId'),
    paths: stringArrayArg(args, 'paths'),
    repoPath: stringArg(args, 'repoPath', false),
  });

  return [
    {
      name: 'deckide.config.get',
      title: 'Get Deck IDE config',
      description: 'Return server defaults such as the default workspace root.',
      inputSchema: emptySchema(),
      handler: apiTool(api, 'GET', '/api/config'),
    },
    {
      name: 'deckide.settings.get',
      title: 'Get settings',
      description: 'Return Deck IDE settings with any configured Basic Auth password masked.',
      inputSchema: emptySchema(),
      handler: apiTool(api, 'GET', '/api/settings'),
    },
    {
      name: 'deckide.settings.update',
      title: 'Update settings',
      description: 'Update Deck IDE settings. A server restart may be required for auth and port changes.',
      inputSchema: schema({
        port: { type: 'number' },
        basicAuthEnabled: { type: 'boolean' },
        basicAuthUser: { type: 'string' },
        basicAuthPassword: { type: 'string' },
      }, ['port', 'basicAuthEnabled', 'basicAuthUser', 'basicAuthPassword']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/settings', (args) => args),
    },
    {
      name: 'deckide.server.shutdown',
      title: 'Shutdown server',
      description: 'Request graceful Deck IDE server shutdown.',
      inputSchema: emptySchema(),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/shutdown', () => ({})),
    },
    {
      name: 'deckide.workspace.list',
      title: 'List workspaces',
      description: 'List all registered workspaces.',
      inputSchema: emptySchema(),
      handler: apiTool(api, 'GET', '/api/workspaces'),
    },
    {
      name: 'deckide.workspace.create',
      title: 'Create workspace',
      description: 'Register a workspace path.',
      inputSchema: schema({ path: pathParam, name: { type: 'string' } }, ['path']),
      handler: apiTool(api, 'POST', '/api/workspaces', (args) => ({
        path: stringArg(args, 'path'),
        name: stringArg(args, 'name', false),
      })),
    },
    {
      name: 'deckide.workspace.delete',
      title: 'Delete workspace',
      description: 'Remove a workspace registration. Files on disk are not deleted.',
      inputSchema: schema({ workspaceId: idParam }, ['workspaceId']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'DELETE', (args) => `/api/workspaces/${encodeURIComponent(stringArg(args, 'workspaceId')!)}`),
    },
    {
      name: 'deckide.file.preview',
      title: 'Preview directory',
      description: 'List a directory before it has been registered as a workspace.',
      inputSchema: schema({ path: pathParam, subpath: pathParam }),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/preview', {
        path: stringArg(args, 'path', false),
        subpath: stringArg(args, 'subpath', false),
      })),
    },
    {
      name: 'deckide.file.list',
      title: 'List files',
      description: 'List files in a workspace directory.',
      inputSchema: schema({ workspaceId: idParam, path: pathParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/files', {
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path', false),
      })),
    },
    {
      name: 'deckide.file.read',
      title: 'Read file',
      description: 'Read a UTF-8 file from a workspace.',
      inputSchema: schema({ workspaceId: idParam, path: pathParam }, ['workspaceId', 'path']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/file', {
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
      })),
    },
    {
      name: 'deckide.file.write',
      title: 'Write file',
      description: 'Write a UTF-8 file in a workspace, creating parent directories as needed.',
      inputSchema: schema({
        workspaceId: idParam,
        path: pathParam,
        contents: { type: 'string' },
      }, ['workspaceId', 'path', 'contents']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'PUT', '/api/file', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
        contents: stringArg(args, 'contents'),
      })),
    },
    {
      name: 'deckide.file.create',
      title: 'Create file',
      description: 'Create a new UTF-8 file in a workspace.',
      inputSchema: schema({
        workspaceId: idParam,
        path: pathParam,
        contents: { type: 'string' },
      }, ['workspaceId', 'path']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/file', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
        contents: stringArg(args, 'contents', false) ?? '',
      })),
    },
    {
      name: 'deckide.file.delete',
      title: 'Delete file',
      description: 'Delete a file in a workspace.',
      inputSchema: schema({ workspaceId: idParam, path: pathParam }, ['workspaceId', 'path']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'DELETE', (args) => appendQuery('/api/file', {
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
      })),
    },
    {
      name: 'deckide.directory.create',
      title: 'Create directory',
      description: 'Create a directory in a workspace.',
      inputSchema: schema({ workspaceId: idParam, path: pathParam }, ['workspaceId', 'path']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/dir', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
      })),
    },
    {
      name: 'deckide.directory.delete',
      title: 'Delete directory',
      description: 'Recursively delete a directory in a workspace.',
      inputSchema: schema({ workspaceId: idParam, path: pathParam }, ['workspaceId', 'path']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'DELETE', (args) => appendQuery('/api/dir', {
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
      })),
    },
    {
      name: 'deckide.deck.list',
      title: 'List decks',
      description: 'List all decks.',
      inputSchema: emptySchema(),
      handler: apiTool(api, 'GET', '/api/decks'),
    },
    {
      name: 'deckide.deck.create',
      title: 'Create deck',
      description: 'Create a deck for a workspace.',
      inputSchema: schema({ workspaceId: idParam, name: { type: 'string' } }, ['workspaceId']),
      handler: apiTool(api, 'POST', '/api/decks', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        name: stringArg(args, 'name', false),
      })),
    },
    {
      name: 'deckide.deck.reorder',
      title: 'Reorder decks',
      description: 'Persist deck ordering.',
      inputSchema: schema({ deckIds: { type: 'array', items: { type: 'string' } } }, ['deckIds']),
      handler: apiTool(api, 'PUT', '/api/decks/order', (args) => ({ deckIds: stringArrayArg(args, 'deckIds') })),
    },
    {
      name: 'deckide.deck.delete',
      title: 'Delete deck',
      description: 'Delete a deck and terminate its terminals.',
      inputSchema: schema({ deckId: idParam }, ['deckId']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'DELETE', (args) => `/api/decks/${encodeURIComponent(stringArg(args, 'deckId')!)}`),
    },
    {
      name: 'deckide.terminal.list',
      title: 'List terminals',
      description: 'List terminals in a deck.',
      inputSchema: schema({ deckId: idParam }, ['deckId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/terminals', { deckId: stringArg(args, 'deckId') })),
    },
    {
      name: 'deckide.terminal.create',
      title: 'Create terminal',
      description: 'Create a terminal in a deck. Optional command runs in the deck workspace shell.',
      inputSchema: schema({
        deckId: idParam,
        title: { type: 'string' },
        command: { type: 'string' },
      }, ['deckId']),
      handler: apiTool(api, 'POST', '/api/terminals', (args) => ({
        deckId: stringArg(args, 'deckId'),
        title: stringArg(args, 'title', false),
        command: stringArg(args, 'command', false),
      })),
    },
    {
      name: 'deckide.terminal.delete',
      title: 'Delete terminal',
      description: 'Delete and kill a terminal.',
      inputSchema: schema({ terminalId: idParam }, ['terminalId']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'DELETE', (args) => `/api/terminals/${encodeURIComponent(stringArg(args, 'terminalId')!)}`),
    },
    {
      name: 'deckide.terminal.write',
      title: 'Write terminal input',
      description: 'Write keyboard input to a terminal PTY.',
      inputSchema: schema({
        terminalId: idParam,
        data: { type: 'string' },
        appendNewline: { type: 'boolean' },
      }, ['terminalId', 'data']),
      annotations: { destructiveHint: true },
      handler: (args) => terminalWrite(options.terminals, args),
    },
    {
      name: 'deckide.terminal.read_buffer',
      title: 'Read terminal buffer',
      description: 'Read buffered terminal output. Use nextOffset for incremental reads.',
      inputSchema: schema({
        terminalId: idParam,
        offset: { type: 'number' },
        maxBytes: { type: 'number', description: '1 to 200000 bytes. Default: 50000.' },
      }, ['terminalId']),
      handler: (args) => terminalReadBuffer(options.terminals, args),
    },
    {
      name: 'deckide.terminal.resize',
      title: 'Resize terminal',
      description: 'Resize a terminal PTY.',
      inputSchema: schema({
        terminalId: idParam,
        cols: { type: 'number' },
        rows: { type: 'number' },
      }, ['terminalId', 'cols', 'rows']),
      handler: (args) => terminalResize(options.terminals, args),
    },
    {
      name: 'deckide.git.status',
      title: 'Get Git status',
      description: 'Return Git status for the workspace root or a nested repo.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/status', {
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.repos',
      title: 'Find Git repos',
      description: 'Find Git repositories inside a workspace.',
      inputSchema: schema({ workspaceId: idParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/repos', { workspaceId: stringArg(args, 'workspaceId') })),
    },
    {
      name: 'deckide.git.multi_status',
      title: 'Get multi-repo Git status',
      description: 'Return aggregated status across all Git repos in a workspace.',
      inputSchema: schema({ workspaceId: idParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/multi-status', { workspaceId: stringArg(args, 'workspaceId') })),
    },
    {
      name: 'deckide.git.stage',
      title: 'Stage Git files',
      description: 'Stage files in a Git repository.',
      inputSchema: schema({
        workspaceId: idParam,
        paths: { type: 'array', items: { type: 'string' } },
        repoPath: repoPathParam,
      }, ['workspaceId', 'paths']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/stage', gitBody),
    },
    {
      name: 'deckide.git.unstage',
      title: 'Unstage Git files',
      description: 'Unstage files in a Git repository.',
      inputSchema: schema({
        workspaceId: idParam,
        paths: { type: 'array', items: { type: 'string' } },
        repoPath: repoPathParam,
      }, ['workspaceId', 'paths']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/unstage', gitBody),
    },
    {
      name: 'deckide.git.commit',
      title: 'Commit Git changes',
      description: 'Create a Git commit.',
      inputSchema: schema({
        workspaceId: idParam,
        message: { type: 'string' },
        repoPath: repoPathParam,
      }, ['workspaceId', 'message']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/commit', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        message: stringArg(args, 'message'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.discard',
      title: 'Discard Git changes',
      description: 'Discard working-tree changes for selected files. Untracked files are deleted.',
      inputSchema: schema({
        workspaceId: idParam,
        paths: { type: 'array', items: { type: 'string' } },
        repoPath: repoPathParam,
      }, ['workspaceId', 'paths']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/discard', gitBody),
    },
    {
      name: 'deckide.git.diff',
      title: 'Get Git diff',
      description: 'Return original and modified file contents for diff display.',
      inputSchema: schema({
        workspaceId: idParam,
        path: pathParam,
        staged: { type: 'boolean' },
        repoPath: repoPathParam,
      }, ['workspaceId', 'path']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/diff', {
        workspaceId: stringArg(args, 'workspaceId'),
        path: stringArg(args, 'path'),
        staged: booleanArg(args, 'staged'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.push',
      title: 'Push Git branch',
      description: 'Push the current branch to origin.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/push', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.pull',
      title: 'Pull Git branch',
      description: 'Pull from the current upstream.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/pull', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.fetch',
      title: 'Fetch Git remotes',
      description: 'Fetch Git remote refs.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      handler: apiTool(api, 'POST', '/api/git/fetch', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.remotes',
      title: 'List Git remotes',
      description: 'List configured remotes for a Git repository.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/remotes', {
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.branch_status',
      title: 'Get Git branch status',
      description: 'Return ahead/behind information for a Git repository.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/branch-status', {
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.branches',
      title: 'List Git branches',
      description: 'List local branches for a Git repository.',
      inputSchema: schema({ workspaceId: idParam, repoPath: repoPathParam }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/branches', {
        workspaceId: stringArg(args, 'workspaceId'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.checkout',
      title: 'Checkout Git branch',
      description: 'Checkout an existing local branch.',
      inputSchema: schema({
        workspaceId: idParam,
        branchName: { type: 'string' },
        repoPath: repoPathParam,
      }, ['workspaceId', 'branchName']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/checkout', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        branchName: stringArg(args, 'branchName'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.create_branch',
      title: 'Create Git branch',
      description: 'Create a local Git branch and optionally check it out.',
      inputSchema: schema({
        workspaceId: idParam,
        branchName: { type: 'string' },
        checkout: { type: 'boolean' },
        repoPath: repoPathParam,
      }, ['workspaceId', 'branchName']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/git/create-branch', (args) => ({
        workspaceId: stringArg(args, 'workspaceId'),
        branchName: stringArg(args, 'branchName'),
        checkout: booleanArg(args, 'checkout'),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.git.log',
      title: 'Get Git log',
      description: 'Return recent Git log entries.',
      inputSchema: schema({
        workspaceId: idParam,
        limit: { type: 'number' },
        repoPath: repoPathParam,
      }, ['workspaceId']),
      handler: apiTool(api, 'GET', (args) => appendQuery('/api/git/log', {
        workspaceId: stringArg(args, 'workspaceId'),
        limit: numberArg(args, 'limit', false),
        repoPath: stringArg(args, 'repoPath', false),
      })),
    },
    {
      name: 'deckide.websocket.stats',
      title: 'Get WebSocket stats',
      description: 'Return WebSocket connection limit and active connection counts.',
      inputSchema: emptySchema(),
      handler: apiTool(api, 'GET', '/api/ws/stats'),
    },
    {
      name: 'deckide.websocket.set_limit',
      title: 'Set WebSocket limit',
      description: 'Set per-IP WebSocket connection limit.',
      inputSchema: schema({ limit: { type: 'number' } }, ['limit']),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'PUT', '/api/ws/limit', (args) => ({ limit: numberArg(args, 'limit') })),
    },
    {
      name: 'deckide.websocket.clear',
      title: 'Clear WebSocket connections',
      description: 'Close all active WebSocket terminal connections.',
      inputSchema: emptySchema(),
      annotations: { destructiveHint: true },
      handler: apiTool(api, 'POST', '/api/ws/clear', () => ({})),
    },
    {
      name: 'deckide.websocket.create_token',
      title: 'Create WebSocket token',
      description: 'Create a short-lived one-time WebSocket auth token.',
      inputSchema: emptySchema(),
      handler: apiTool(api, 'GET', '/api/ws-token'),
    },
    {
      name: 'deckide.api.request',
      title: 'Call Deck IDE API',
      description: 'Low-level fallback for Deck IDE HTTP API routes. Path must start with /api/.',
      inputSchema: schema({
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'An /api/... path.' },
        query: { type: 'object' },
        body: { type: 'object' },
      }, ['method', 'path']),
      annotations: { destructiveHint: true },
      handler: (args) => {
        const method = stringArg(args, 'method')!.toUpperCase();
        const path = stringArg(args, 'path')!;
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
          throw new ToolExecutionError('method must be GET, POST, PUT, or DELETE', 400);
        }
        if (!path.startsWith('/api/')) {
          throw new ToolExecutionError('path must start with /api/', 400);
        }
        const query = objectArg(args, 'query');
        const body = objectArg(args, 'body');
        return apiJson(api, method, appendQuery(path, query), body);
      },
    },
  ];
}

function toolResult(data: unknown) {
  const structuredContent = isObject(data) ? data : { result: data as JsonValue };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent,
    isError: false,
  };
}

function toolErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ToolExecutionError ? error.status : undefined;
  const data = error instanceof ToolExecutionError ? error.data : undefined;
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message, status, data },
    isError: true,
  };
}

function isAllowedMcpOrigin(c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;

  const allowed = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`,
  ]);
  if (CORS_ORIGIN) allowed.add(CORS_ORIGIN);
  if (NODE_ENV === 'development') {
    allowed.add('http://localhost:5173');
    allowed.add('http://localhost:3000');
  }
  return allowed.has(origin);
}

export function createMcpRouter(options: CreateMcpRouterOptions) {
  const router = new Hono();
  const tools = buildTools(options);
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

  async function handleMcpRequest(message: JsonRecord, resource: string) {
    const id = (message.id ?? null) as RequestId;
    const method = message.method;

    if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
      return jsonRpcError(id, -32600, 'Invalid JSON-RPC request');
    }

    switch (method) {
      case 'initialize': {
        const params = isObject(message.params) ? message.params : {};
        const requestedVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : PROTOCOL_VERSION;
        return jsonRpcResult(id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'deckide',
            title: 'Deck IDE',
            version: '3.5.33',
            description: 'Deck IDE MCP server for workspace, file, terminal, Git, and settings operations.',
          },
          instructions: 'Use Deck IDE tools to inspect and operate registered workspaces. Destructive file, Git, terminal, settings, and shutdown tools can change local state.',
        });
      }
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, {
          tools: tools.map(({ handler: _handler, ...tool }) => tool),
        });
      case 'tools/call': {
        const params = isObject(message.params) ? message.params : {};
        const name = params.name;
        const args = isObject(params.arguments) ? params.arguments : {};
        if (typeof name !== 'string') {
          return jsonRpcError(id, -32602, 'tools/call params.name is required');
        }
        const tool = toolByName.get(name);
        if (!tool) {
          return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
        }
        try {
          const result = await tool.handler(args, { resource });
          return jsonRpcResult(id, toolResult(result));
        } catch (error) {
          return jsonRpcResult(id, toolErrorResult(error));
        }
      }
      default:
        if (method.startsWith('notifications/')) {
          return null;
        }
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  router.get('/.well-known/oauth-protected-resource', (c) => {
    const baseUrl = getBaseUrl(c);
    return c.json({
      resource: getMcpResource(c),
      authorization_servers: [baseUrl],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl}/`,
    });
  });

  router.get('/.well-known/oauth-protected-resource/mcp', (c) => {
    const baseUrl = getBaseUrl(c);
    return c.json({
      resource: getMcpResource(c),
      authorization_servers: [baseUrl],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl}/`,
    });
  });

  router.get('/.well-known/oauth-authorization-server', (c) => {
    const baseUrl = getBaseUrl(c);
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [OAUTH_SCOPE],
      resource_parameter_supported: true,
    });
  });

  router.post('/oauth/register', async (c) => {
    let body: JsonRecord;
    try {
      body = await c.req.json<JsonRecord>();
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Expected JSON body' }, 400);
    }

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
      : [];
    if (redirectUris.length === 0 || redirectUris.some((uri) => !validRedirectUri(uri))) {
      return c.json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must contain HTTPS or localhost HTTP redirect URIs',
      }, 400);
    }

    const clientId = `deckide-${crypto.randomUUID()}`;
    const client: OAuthClient = {
      clientId,
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirectUris,
      issuedAt: Math.floor(Date.now() / 1000),
    };
    clients.set(clientId, client);

    return c.json({
      client_id: client.clientId,
      client_id_issued_at: client.issuedAt,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPE,
    }, 201);
  });

  router.get('/oauth/authorize', (c) => {
    try {
      const params = new URL(c.req.url).searchParams;
      const { client } = validateAuthorizationRequest(params, c);
      return c.html(renderConsentPage(params, client));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.text(message, error instanceof ToolExecutionError && error.status ? error.status as 400 : 400);
    }
  });

  router.post('/oauth/authorize', async (c) => {
    try {
      const params = await readForm(c);
      const state = params.get('state') || undefined;
      const decision = params.get('decision');
      const validated = validateAuthorizationRequest(params, c);

      if (decision !== 'approve') {
        return redirectWithParams(validated.redirectUri, {
          error: 'access_denied',
          ...(state ? { state } : {}),
        });
      }

      const code = crypto.randomBytes(32).toString('base64url');
      authorizationCodes.set(code, {
        code,
        clientId: validated.clientId,
        redirectUri: validated.redirectUri,
        codeChallenge: validated.codeChallenge,
        scopes: validated.scopes,
        resource: validated.resource,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      });

      return redirectWithParams(validated.redirectUri, {
        code,
        ...(state ? { state } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.text(message, error instanceof ToolExecutionError && error.status ? error.status as 400 : 400);
    }
  });

  router.post('/oauth/token', async (c) => {
    const form = await readForm(c);
    const grantType = form.get('grant_type');
    const code = form.get('code');
    const redirectUri = form.get('redirect_uri');
    const clientId = form.get('client_id');
    const codeVerifier = form.get('code_verifier');
    const resource = form.get('resource');

    if (grantType !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400);
    }
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const record = authorizationCodes.get(code);
    if (!record || record.expiresAt <= Date.now()) {
      authorizationCodes.delete(code);
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (resource && resource !== record.resource) {
      return c.json({ error: 'invalid_target' }, 400);
    }
    if (hashCodeVerifier(codeVerifier) !== record.codeChallenge) {
      return c.json({ error: 'invalid_grant' }, 400);
    }

    authorizationCodes.delete(code);
    const token = crypto.randomBytes(32).toString('base64url');
    accessTokens.set(token, {
      token,
      clientId,
      scopes: record.scopes,
      resource: record.resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });

    return c.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: record.scopes.join(' '),
    });
  });

  router.all('/mcp', async (c) => {
    if (!isAllowedMcpOrigin(c)) {
      return c.json(jsonRpcError(null, -32000, 'Invalid Origin header'), 403);
    }

    if (c.req.method === 'GET') {
      if (!validateAccessToken(c)) {
        c.header('WWW-Authenticate', bearerChallenge(c, 'invalid_token'));
        return c.json({ error: 'unauthorized' }, 401);
      }
      c.header('Allow', 'POST, GET');
      return c.body(null, 405);
    }

    if (c.req.method === 'DELETE') {
      c.header('Allow', 'POST, GET');
      return c.body(null, 405);
    }

    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST, GET');
      return c.body(null, 405);
    }

    const protocolVersion = c.req.header('mcp-protocol-version');
    if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      return c.json(jsonRpcError(null, -32600, `Unsupported MCP protocol version: ${protocolVersion}`), 400);
    }

    const token = validateAccessToken(c);
    if (!token) {
      c.header('WWW-Authenticate', bearerChallenge(c, 'invalid_token'));
      return c.json({ error: 'unauthorized' }, 401);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, -32700, 'Parse error'), 400);
    }

    const resource = getMcpResource(c);
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((item) =>
        isObject(item) ? handleMcpRequest(item, resource) : jsonRpcError(null, -32600, 'Invalid JSON-RPC request')
      ))).filter(Boolean);
      if (responses.length === 0) return c.body(null, 202);
      return c.json(responses);
    }

    if (!isObject(payload)) {
      return c.json(jsonRpcError(null, -32600, 'Invalid JSON-RPC request'), 400);
    }

    const response = await handleMcpRequest(payload, resource);
    if (!response) return c.body(null, 202);
    return c.json(response);
  });

  return router;
}
