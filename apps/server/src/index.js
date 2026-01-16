import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'node-pty';

const DEFAULT_ROOT = process.env.DEFAULT_ROOT || 'C:/workspace';
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.json({ limit: '2mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', '..', 'web', 'dist');
const hasStatic = fsSync.existsSync(distDir);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const workspaces = new Map();
const workspacePathIndex = new Map();
const decks = new Map();
const terminals = new Map();

function normalizeWorkspacePath(inputPath = '') {
  return path.resolve(inputPath || DEFAULT_ROOT);
}

function getWorkspaceKey(workspacePath) {
  const normalized = workspacePath.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getWorkspaceName(workspacePath, index) {
  const trimmed = workspacePath.replace(/[\\/]+$/, '');
  const base = path.basename(trimmed);
  return base || `Project ${index}`;
}

function createWorkspace(inputPath, name) {
  const resolvedPath = normalizeWorkspacePath(inputPath);
  const key = getWorkspaceKey(resolvedPath);
  if (workspacePathIndex.has(key)) {
    const error = new Error('Workspace path already exists');
    error.status = 409;
    throw error;
  }
  const workspace = {
    id: crypto.randomUUID(),
    name: name || getWorkspaceName(resolvedPath, workspaces.size + 1),
    path: resolvedPath,
    createdAt: new Date().toISOString()
  };
  workspaces.set(workspace.id, workspace);
  workspacePathIndex.set(key, workspace.id);
  return workspace;
}

function requireWorkspace(workspaceId) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) {
    const error = new Error('Workspace not found');
    error.status = 404;
    throw error;
  }
  return workspace;
}

function createDeck(name, workspaceId) {
  const workspace = requireWorkspace(workspaceId);
  const deck = {
    id: crypto.randomUUID(),
    name: name || `Deck ${decks.size + 1}`,
    root: workspace.path,
    workspaceId,
    createdAt: new Date().toISOString()
  };
  decks.set(deck.id, deck);
  return deck;
}

function resolveSafePath(workspacePath, inputPath = '') {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Path escapes root');
    error.status = 400;
    throw error;
  }
  return resolved;
}

function handleError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'Unexpected error'
  });
}

createWorkspace(DEFAULT_ROOT);

app.get('/api/workspaces', (req, res) => {
  res.json(Array.from(workspaces.values()));
});

app.post('/api/workspaces', (req, res) => {
  try {
    if (!req.body?.path) {
      const error = new Error('path is required');
      error.status = 400;
      throw error;
    }
    const workspace = createWorkspace(req.body?.path, req.body?.name);
    res.status(201).json(workspace);
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/decks', (req, res) => {
  res.json(Array.from(decks.values()));
});

app.post('/api/decks', (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) {
      const error = new Error('workspaceId is required');
      error.status = 400;
      throw error;
    }
    const deck = createDeck(req.body?.name, workspaceId);
    res.status(201).json(deck);
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/files', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) {
      const error = new Error('workspaceId is required');
      error.status = 400;
      throw error;
    }
    const workspace = requireWorkspace(workspaceId);
    const requestedPath = req.query.path || '';
    const target = resolveSafePath(workspace.path, requestedPath);
    const stats = await fs.stat(target);
    if (!stats.isDirectory()) {
      const error = new Error('Path is not a directory');
      error.status = 400;
      throw error;
    }
    const entries = await fs.readdir(target, { withFileTypes: true });
    const normalizedBase = requestedPath.replace(/\\/g, '/');
    const mapped = entries.map((entry) => {
      const entryPath = normalizedBase
        ? `${normalizedBase}/${entry.name}`
        : entry.name;
      return {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? 'dir' : 'file'
      };
    });
    mapped.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    res.json(mapped);
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/file', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) {
      const error = new Error('workspaceId is required');
      error.status = 400;
      throw error;
    }
    const workspace = requireWorkspace(workspaceId);
    const target = resolveSafePath(workspace.path, req.query.path || '');
    const contents = await fs.readFile(target, 'utf8');
    res.json({ path: req.query.path, contents });
  } catch (error) {
    handleError(res, error);
  }
});

app.put('/api/file', async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) {
      const error = new Error('workspaceId is required');
      error.status = 400;
      throw error;
    }
    const workspace = requireWorkspace(workspaceId);
    const target = resolveSafePath(workspace.path, req.body?.path || '');
    const contents = req.body?.contents ?? '';
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
    res.json({ path: req.body?.path, saved: true });
  } catch (error) {
    handleError(res, error);
  }
});

if (hasStatic) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.post('/api/terminals', (req, res) => {
  const deckId = req.body?.deckId;
  if (!deckId || !decks.has(deckId)) {
    res.status(400).json({ error: 'deckId is required' });
    return;
  }
  const deck = decks.get(deckId);
  const id = crypto.randomUUID();
  const shell =
    process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : 'bash');
  const term = spawn(shell, [], {
    cwd: deck.root,
    cols: 120,
    rows: 32,
    env: process.env
  });
  terminals.set(id, term);
  res.status(201).json({ id });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const match = url.pathname.match(/\/api\/terminals\/(.+)/);
  if (!match) {
    socket.close();
    return;
  }
  const id = match[1];
  const term = terminals.get(id);
  if (!term) {
    socket.close();
    return;
  }

  term.onData((data) => {
    socket.send(data);
  });

  socket.on('message', (data) => {
    term.write(data.toString());
  });

  socket.on('close', () => {
    term.kill();
    terminals.delete(id);
  });
});

server.listen(PORT, () => {
  const baseUrl = `http://localhost:${PORT}`;
  console.log(`Deck IDE server listening on ${baseUrl}`);
  console.log(`UI: ${baseUrl}`);
  console.log(`API: ${baseUrl}/api`);
});
