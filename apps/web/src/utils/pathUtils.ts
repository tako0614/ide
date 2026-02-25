/**
 * Path manipulation utilities
 */

/**
 * Normalizes a workspace path to lowercase with forward slashes
 */
export function normalizeWorkspacePath(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

/**
 * Determines the path separator used in the given path
 */
export function getPathSeparator(value: string): string {
  return value.includes('\\') ? '\\' : '/';
}

/**
 * Joins two path segments using the appropriate separator
 */
export function joinPath(base: string, next: string): string {
  const separator = getPathSeparator(base);
  const trimmed = base.replace(/[\\/]+$/, '');
  return trimmed ? `${trimmed}${separator}${next}` : next;
}

/**
 * Gets the parent directory path
 */
export function getParentPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  if (!trimmed) return value;
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  if (trimmed === '/') {
    return '/';
  }
  const lastSlash = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\')
  );
  if (trimmed.startsWith('/') && lastSlash === 0) {
    return '/';
  }
  if (lastSlash <= 0) {
    return trimmed;
  }
  const parent = trimmed.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}\\`;
  }
  return parent;
}
