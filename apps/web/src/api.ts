import type { Deck, FileSystemEntry, Workspace, GitStatus, GitDiff, GitRepoInfo, MultiRepoGitStatus, AgentSession, CreateAgentRequest, AgentMessage, AgentStatus } from './types';
import { API_BASE } from './constants';

const HTTP_STATUS_NO_CONTENT = 204;

/**
 * Makes an HTTP request to the API
 * @param path - API endpoint path
 * @param options - Fetch options
 * @returns Parsed JSON response
 * @throws Error if request fails
 */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include'
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  if (response.status === HTTP_STATUS_NO_CONTENT) {
    return null as T;
  }
  return response.json() as Promise<T>;
}

const CONTENT_TYPE_JSON = 'application/json';
const HTTP_METHOD_POST = 'POST';
const HTTP_METHOD_PUT = 'PUT';
const HTTP_METHOD_DELETE = 'DELETE';

/**
 * Converts HTTP(S) base URL to WebSocket URL
 */
export function getWsBase(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws');
}

/**
 * Fetches a one-time WebSocket authentication token
 */
export function getWsToken(): Promise<{ token: string; authEnabled: boolean }> {
  return request<{ token: string; authEnabled: boolean }>('/api/ws-token');
}

/**
 * Fetches all workspaces
 */
export function listWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>('/api/workspaces');
}

/**
 * Fetches server configuration
 */
export function getConfig(): Promise<{ defaultRoot?: string }> {
  return request<{ defaultRoot?: string }>('/api/config');
}

/**
 * Creates a new workspace
 */
export function createWorkspace(path: string): Promise<Workspace> {
  return request<Workspace>('/api/workspaces', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ path })
  });
}

/**
 * Fetches all decks
 */
export function listDecks(): Promise<Deck[]> {
  return request<Deck[]>('/api/decks');
}

/**
 * Creates a new deck
 */
export function createDeck(name: string, workspaceId: string): Promise<Deck> {
  return request<Deck>('/api/decks', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ name, workspaceId })
  });
}

/**
 * Lists files in a workspace directory
 */
export function listFiles(
  workspaceId: string,
  path = ''
): Promise<FileSystemEntry[]> {
  const query = new URLSearchParams({ workspaceId, path });
  return request<FileSystemEntry[]>(`/api/files?${query.toString()}`);
}

/**
 * Previews files in a directory (without workspace context)
 */
export function previewFiles(
  rootPath: string,
  subpath = ''
): Promise<FileSystemEntry[]> {
  const query = new URLSearchParams({ path: rootPath, subpath });
  return request<FileSystemEntry[]>(`/api/preview?${query.toString()}`);
}

/**
 * Reads the contents of a file
 */
export function readFile(
  workspaceId: string,
  path: string
): Promise<{ path: string; contents: string }> {
  const query = new URLSearchParams({ workspaceId, path });
  return request<{ path: string; contents: string }>(
    `/api/file?${query.toString()}`
  );
}

/**
 * Writes contents to a file
 */
export function writeFile(
  workspaceId: string,
  path: string,
  contents: string
): Promise<{ path: string; saved: boolean }> {
  return request<{ path: string; saved: boolean }>('/api/file', {
    method: HTTP_METHOD_PUT,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, path, contents })
  });
}

/**
 * Creates a new file
 */
export function createFile(
  workspaceId: string,
  path: string,
  contents = ''
): Promise<{ path: string; created: boolean }> {
  return request<{ path: string; created: boolean }>('/api/file', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, path, contents })
  });
}

/**
 * Deletes a file
 */
export function deleteFile(
  workspaceId: string,
  path: string
): Promise<{ path: string; deleted: boolean }> {
  const query = new URLSearchParams({ workspaceId, path });
  return request<{ path: string; deleted: boolean }>(
    `/api/file?${query.toString()}`,
    { method: HTTP_METHOD_DELETE }
  );
}

/**
 * Creates a new directory
 */
export function createDirectory(
  workspaceId: string,
  path: string
): Promise<{ path: string; created: boolean }> {
  return request<{ path: string; created: boolean }>('/api/dir', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, path })
  });
}

/**
 * Deletes a directory
 */
export function deleteDirectory(
  workspaceId: string,
  path: string
): Promise<{ path: string; deleted: boolean }> {
  const query = new URLSearchParams({ workspaceId, path });
  return request<{ path: string; deleted: boolean }>(
    `/api/dir?${query.toString()}`,
    { method: HTTP_METHOD_DELETE }
  );
}

/**
 * Creates a new terminal session
 */
export function createTerminal(
  deckId: string,
  title?: string,
  command?: string
): Promise<{ id: string; title: string }> {
  return request<{ id: string; title: string }>('/api/terminals', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ deckId, title, command })
  });
}

/**
 * Lists all terminals for a deck
 */
export function listTerminals(
  deckId: string
): Promise<{ id: string; title: string }[]> {
  const query = new URLSearchParams({ deckId });
  return request<{ id: string; title: string }[]>(
    `/api/terminals?${query.toString()}`
  );
}

/**
 * Deletes a terminal session
 */
export function deleteTerminal(terminalId: string): Promise<void> {
  return request<void>(`/api/terminals/${terminalId}`, {
    method: HTTP_METHOD_DELETE
  });
}

/**
 * Fetches Git status for a workspace or specific repo within workspace
 */
export function getGitStatus(workspaceId: string, repoPath?: string): Promise<GitStatus> {
  const params: Record<string, string> = { workspaceId };
  if (repoPath !== undefined) {
    params.repoPath = repoPath;
  }
  const query = new URLSearchParams(params);
  return request<GitStatus>(`/api/git/status?${query.toString()}`);
}

/**
 * Lists all git repositories within a workspace
 */
export function getGitRepos(workspaceId: string): Promise<{ repos: GitRepoInfo[] }> {
  const query = new URLSearchParams({ workspaceId });
  return request<{ repos: GitRepoInfo[] }>(`/api/git/repos?${query.toString()}`);
}

/**
 * Gets aggregated status from all git repos in a workspace
 */
export function getMultiRepoStatus(workspaceId: string): Promise<MultiRepoGitStatus> {
  const query = new URLSearchParams({ workspaceId });
  return request<MultiRepoGitStatus>(`/api/git/multi-status?${query.toString()}`);
}

/**
 * Stages files for commit
 */
export function stageFiles(
  workspaceId: string,
  paths: string[],
  repoPath?: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/git/stage', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, paths, repoPath })
  });
}

/**
 * Unstages files from commit
 */
export function unstageFiles(
  workspaceId: string,
  paths: string[],
  repoPath?: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/git/unstage', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, paths, repoPath })
  });
}

/**
 * Commits staged changes
 */
export function commitChanges(
  workspaceId: string,
  message: string,
  repoPath?: string
): Promise<{
  success: boolean;
  commit: string;
  summary: { changes: number; insertions: number; deletions: number };
}> {
  return request('/api/git/commit', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, message, repoPath })
  });
}

/**
 * Discards changes to files
 */
export function discardChanges(
  workspaceId: string,
  paths: string[],
  repoPath?: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/git/discard', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, paths, repoPath })
  });
}

/**
 * Gets diff for a file
 */
export function getGitDiff(
  workspaceId: string,
  path: string,
  staged: boolean,
  repoPath?: string
): Promise<GitDiff> {
  const params: Record<string, string> = {
    workspaceId,
    path,
    staged: staged.toString()
  };
  if (repoPath !== undefined) {
    params.repoPath = repoPath;
  }
  const query = new URLSearchParams(params);
  return request<GitDiff>(`/api/git/diff?${query.toString()}`);
}

/**
 * Pushes commits to remote
 */
export function pushChanges(
  workspaceId: string,
  repoPath?: string
): Promise<{ success: boolean; branch: string }> {
  return request('/api/git/push', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, repoPath })
  });
}

/**
 * Pulls changes from remote
 */
export function pullChanges(
  workspaceId: string,
  repoPath?: string
): Promise<{
  success: boolean;
  summary: { changes: number; insertions: number; deletions: number };
}> {
  return request('/api/git/pull', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, repoPath })
  });
}

/**
 * Fetches from remote
 */
export function fetchChanges(
  workspaceId: string,
  repoPath?: string
): Promise<{ success: boolean }> {
  return request('/api/git/fetch', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, repoPath })
  });
}

/**
 * Gets branch status (ahead/behind)
 */
export function getBranchStatus(
  workspaceId: string,
  repoPath?: string
): Promise<{ ahead: number; behind: number; hasUpstream: boolean }> {
  const params: Record<string, string> = { workspaceId };
  if (repoPath !== undefined) {
    params.repoPath = repoPath;
  }
  const query = new URLSearchParams(params);
  return request(`/api/git/branch-status?${query.toString()}`);
}

/**
 * Gets remote configuration
 */
export function getGitRemotes(
  workspaceId: string,
  repoPath?: string
): Promise<{
  remotes: { name: string; fetchUrl: string; pushUrl: string }[];
  hasRemote: boolean;
}> {
  const params: Record<string, string> = { workspaceId };
  if (repoPath !== undefined) {
    params.repoPath = repoPath;
  }
  const query = new URLSearchParams(params);
  return request(`/api/git/remotes?${query.toString()}`);
}

/**
 * Lists all branches
 */
export function listBranches(
  workspaceId: string,
  repoPath?: string
): Promise<{
  branches: { name: string; current: boolean }[];
  currentBranch: string;
}> {
  const params: Record<string, string> = { workspaceId };
  if (repoPath !== undefined) {
    params.repoPath = repoPath;
  }
  const query = new URLSearchParams(params);
  return request(`/api/git/branches?${query.toString()}`);
}

/**
 * Checkout a branch
 */
export function checkoutBranch(
  workspaceId: string,
  branchName: string,
  repoPath?: string
): Promise<{ success: boolean }> {
  return request('/api/git/checkout', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, branchName, repoPath })
  });
}

/**
 * Create a new branch
 */
export function createBranch(
  workspaceId: string,
  branchName: string,
  checkout = true,
  repoPath?: string
): Promise<{ success: boolean }> {
  return request('/api/git/create-branch', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify({ workspaceId, branchName, checkout, repoPath })
  });
}

/**
 * Get git log
 */
export function getGitLog(
  workspaceId: string,
  limit = 50,
  repoPath?: string
): Promise<{
  logs: {
    hash: string;
    hashShort: string;
    message: string;
    author: string;
    date: string;
  }[];
}> {
  const params: Record<string, string> = { workspaceId, limit: String(limit) };
  if (repoPath !== undefined) {
    params.repoPath = repoPath;
  }
  const query = new URLSearchParams(params);
  return request(`/api/git/log?${query.toString()}`);
}

// ===== Agent API =====

/**
 * Lists all agent sessions
 */
export function listAgentSessions(): Promise<AgentSession[]> {
  return request<AgentSession[]>('/api/agents');
}

/**
 * Creates a new agent session
 */
export function createAgentSession(req: CreateAgentRequest): Promise<AgentSession> {
  return request<AgentSession>('/api/agents', {
    method: HTTP_METHOD_POST,
    headers: { 'Content-Type': CONTENT_TYPE_JSON },
    body: JSON.stringify(req)
  });
}

/**
 * Gets agent session details
 */
export function getAgentSession(id: string): Promise<AgentSession> {
  return request<AgentSession>(`/api/agents/${id}`);
}

/**
 * Deletes/aborts an agent session
 */
export function deleteAgentSession(id: string): Promise<void> {
  return request<void>(`/api/agents/${id}`, {
    method: HTTP_METHOD_DELETE
  });
}

/**
 * Connects to agent SSE stream using fetch (supports Basic Auth via credentials: 'include').
 * Returns cleanup function to close the connection.
 */
export function streamAgentSession(
  id: string,
  onMessage: (msg: AgentMessage) => void,
  onStatus: (status: AgentStatus, extra?: { error?: string; durationMs?: number; totalCostUsd?: number }) => void,
  onError: (err: Error) => void
): () => void {
  const base = API_BASE || '';
  const url = `${base}/api/agents/${id}/stream`;
  let aborted = false;
  const controller = new AbortController();

  const MAX_RECONNECT = 3;
  let reconnectAttempt = 0;

  function connect() {
    fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed (${response.status})`);
        }
        reconnectAttempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentData = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentData += line.slice(5).trim();
            } else if (line === '') {
              // End of SSE message
              if (currentEvent && currentData) {
                try {
                  const parsed = JSON.parse(currentData);
                  if (currentEvent === 'message') {
                    onMessage(parsed);
                  } else if (currentEvent === 'status') {
                    onStatus(parsed.status, {
                      error: parsed.error,
                      durationMs: parsed.durationMs,
                      totalCostUsd: parsed.totalCostUsd
                    });
                  }
                  // 'init' event is ignored (initial state handled by listing)
                } catch {
                  // ignore parse errors
                }
              }
              currentEvent = '';
              currentData = '';
            }
          }
        }

        // Stream ended normally - if agent was still running, try reconnect
        if (!aborted && reconnectAttempt < MAX_RECONNECT) {
          reconnectAttempt++;
          setTimeout(connect, 1000 * reconnectAttempt);
        }
      })
      .catch((err: unknown) => {
        if (aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (reconnectAttempt < MAX_RECONNECT) {
          reconnectAttempt++;
          setTimeout(connect, 1000 * reconnectAttempt);
        } else {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
  }

  connect();

  return () => {
    aborted = true;
    controller.abort();
  };
}
