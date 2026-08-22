/**
 * Theme selection. "system" follows the OS preference; the rest are explicit.
 * The resolved value is written to <html data-theme> and drives the CSS tokens.
 */
export type ThemeMode = 'system' | 'light' | 'dark' | 'retro' | 'blackmetal';
export type ResolvedTheme = 'light' | 'dark' | 'retro' | 'blackmetal';

export const THEME_MODES: Array<{ mode: ThemeMode; label: string; hint: string }> = [
  { mode: 'system', label: 'System', hint: 'Follow the operating system' },
  { mode: 'light', label: 'Light', hint: 'Bright, low contrast' },
  { mode: 'dark', label: 'Dark', hint: 'The default' },
  { mode: 'retro', label: 'Retro 8-bit', hint: 'CRT phosphor and hard pixels' },
  { mode: 'blackmetal', label: 'Black Metal', hint: 'Grim, frostbitten, monochrome' },
];

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some((item) => item.mode === value);
}

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** Page background per theme, mirrored into <meta name="theme-color"> so the
 *  browser chrome (mobile address bar, PWA title bar) matches the page. */
const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f4f6fb',
  dark: '#0b0d13',
  retro: '#12082a',
  blackmetal: '#000000',
};

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[resolved]);
  return resolved;
}
