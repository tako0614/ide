// Node.js-specific utility functions
// This file should only be imported in Node.js environments (server)

import path from 'node:path';

/**
 * Normalize a workspace path to an absolute path (Node.js version)
 * @param inputPath - Input path (can be relative or absolute)
 * @param defaultPath - Default path to use if inputPath is empty
 * @returns Normalized absolute path
 */
export function normalizeWorkspacePath(inputPath: string, defaultPath: string): string {
  return path.resolve(inputPath || defaultPath);
}

/**
 * Get a workspace key for indexing (handles case-insensitivity on Windows)
 * @param workspacePath - Workspace path
 * @returns Normalized key for indexing
 */
export function getWorkspaceKey(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Extract a workspace name from its path
 * @param workspacePath - Workspace path
 * @param fallbackIndex - Index to use for fallback name
 * @returns Workspace name
 */
export function getWorkspaceName(workspacePath: string, fallbackIndex: number): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, '');
  const base = path.basename(trimmed);
  return base || `Project ${fallbackIndex}`;
}

// Re-export browser-compatible utilities
export {
  getFileExtension,
  getLanguageFromPath,
  normalizePathSeparators,
  isHidden,
  getErrorMessage,
  createHttpError,
  truncate,
  shortId,
  formatFileSize,
  sortFileEntries
} from './utils.js';
