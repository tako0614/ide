/**
 * Theme management utilities
 */

import { STORAGE_KEY_THEME } from '../constants';

export type ThemeMode = 'light' | 'dark';

/**
 * Gets the initial theme from localStorage or system preference
 */
export function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }
  const stored = window.localStorage.getItem(STORAGE_KEY_THEME);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
