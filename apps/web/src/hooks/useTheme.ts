import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEY_THEME } from '../constants';
import { getInitialTheme } from '../utils/themeUtils';
import type { ThemeMode } from '../utils/themeUtils';

export type { ThemeMode };

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY_THEME, theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, handleToggleTheme };
}
