import { useEffect, useState } from 'react';

export type ThemeChoice = 'dark' | 'light';

const KEY = 'gqlwb.theme';

export function readTheme(): ThemeChoice {
  const stored = localStorage.getItem(KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeChoice): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(KEY, theme);
}

export function useTheme(): [ThemeChoice, (theme: ThemeChoice) => void] {
  const [theme, setThemeState] = useState<ThemeChoice>(() => readTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return [theme, setThemeState];
}
