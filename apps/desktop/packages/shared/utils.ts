// Shared utility functions (browser-compatible)

/**
 * Get a workspace key for indexing (handles case-insensitivity on Windows)
 * @param workspacePath - Workspace path
 * @returns Normalized key for indexing
 */
export function getWorkspaceKey(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, '');
  // In browser, we can't detect platform, so we normalize to lowercase
  const platform = typeof process !== 'undefined' ? process.platform : 'unknown';
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Extract a workspace name from its path
 * @param workspacePath - Workspace path
 * @param fallbackIndex - Index to use for fallback name
 * @returns Workspace name
 */
export function getWorkspaceName(workspacePath: string, fallbackIndex: number): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, '');
  // Browser-compatible basename
  const parts = trimmed.split(/[\\/]/);
  const base = parts[parts.length - 1] || '';
  return base || `Project ${fallbackIndex}`;
}

/**
 * Normalize a workspace path to an absolute path
 * Note: This function requires Node.js path module
 * For browser usage, import from utils-node.ts instead
 * @param inputPath - Input path (can be relative or absolute)
 * @param defaultPath - Default path to use if inputPath is empty
 * @returns Normalized absolute path
 */
export function normalizeWorkspacePath(inputPath: string, defaultPath: string): string {
  // This is a simplified version for browsers
  // Server code should use the Node.js version from utils-node.ts
  return inputPath || defaultPath;
}

/**
 * Get file extension from a path
 * @param filePath - File path
 * @returns File extension (without dot) or empty string
 */
export function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) return '';
  const ext = filePath.slice(lastDot + 1);
  return ext.toLowerCase();
}

/**
 * Map file extension to Monaco editor language
 * @param filePath - File path
 * @returns Monaco language identifier
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = getFileExtension(filePath);
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'json': 'json',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'md': 'markdown',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'sql': 'sql',
    'graphql': 'graphql',
    'vue': 'vue',
    'svelte': 'svelte',
    'php': 'php',
    'r': 'r',
    'swift': 'swift',
    'kt': 'kotlin',
    'dart': 'dart',
    'lua': 'lua',
    'dockerfile': 'dockerfile',
  };

  return languageMap[ext] || 'plaintext';
}

/**
 * Normalize path separators to forward slashes
 * @param inputPath - Input path
 * @returns Path with forward slashes
 */
export function normalizePathSeparators(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

/**
 * Check if a path is a hidden file or directory (starts with .)
 * @param name - File or directory name
 * @returns True if hidden
 */
export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Get error message from unknown error type
 * @param error - Error object
 * @returns Error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Create an HTTP error with status code
 * @param message - Error message
 * @param status - HTTP status code
 * @returns Error object with status property
 */
export function createHttpError(message: string, status: number): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

/**
 * Truncate string to max length with ellipsis
 * @param str - Input string
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Generate a short ID from a UUID (first 8 characters)
 * @param uuid - Full UUID
 * @returns Short ID
 */
export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

/**
 * Format file size in human-readable format
 * @param bytes - File size in bytes
 * @returns Formatted file size string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Sort file system entries (directories first, then alphabetically)
 * @param entries - Array of file system entries
 * @returns Sorted array
 */
export function sortFileEntries<T extends { name: string; type: 'file' | 'dir' }>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
