import type { Deck, FileSystemEntry, Workspace } from './types';

const API_BASE = import.meta.env.VITE_API_BASE || '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  if (response.status === 204) {
    return null as T;
  }
  return response.json() as Promise<T>;
}

export function getWsBase(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws');
}

export function listWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>('/api/workspaces');
}

export function createWorkspace(path: string): Promise<Workspace> {
  return request<Workspace>('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
}

export function listDecks(): Promise<Deck[]> {
  return request<Deck[]>('/api/decks');
}

export function createDeck(name: string, workspaceId: string): Promise<Deck> {
  return request<Deck>('/api/decks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, workspaceId })
  });
}

export function listFiles(
  workspaceId: string,
  path = ''
): Promise<FileSystemEntry[]> {
  const query = new URLSearchParams({ workspaceId, path });
  return request<FileSystemEntry[]>(`/api/files?${query.toString()}`);
}

export function readFile(
  workspaceId: string,
  path: string
): Promise<{ path: string; contents: string }> {
  const query = new URLSearchParams({ workspaceId, path });
  return request<{ path: string; contents: string }>(
    `/api/file?${query.toString()}`
  );
}

export function writeFile(
  workspaceId: string,
  path: string,
  contents: string
): Promise<{ path: string; saved: boolean }> {
  return request<{ path: string; saved: boolean }>('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, path, contents })
  });
}

export function createTerminal(deckId: string): Promise<{ id: string }> {
  return request<{ id: string }>('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deckId })
  });
}
