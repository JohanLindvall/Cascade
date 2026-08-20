/**
 * Theme selection. "system" follows the OS preference; the rest are explicit.
 * The resolved value is written to <html data-theme> and drives the CSS tokens.
 */
export type ThemeMode = 'system' | 'light' | 'dark' | 'retro';
export type ResolvedTheme = 'light' | 'dark' | 'retro';

export const THEME_MODES: Array<{ mode: ThemeMode; label: string; hint: string }> = [
  { mode: 'system', label: 'System', hint: 'Follow the operating system' },
  { mode: 'light', label: 'Light', hint: 'Bright, low contrast' },
  { mode: 'dark', label: 'Dark', hint: 'The default' },
  { mode: 'retro', label: 'Retro 8-bit', hint: 'CRT phosphor and hard pixels' },
];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark' || value === 'retro';
}

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
