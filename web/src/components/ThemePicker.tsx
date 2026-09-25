import { useEffect, useRef, useState, type ComponentType } from 'react';
import { THEME_MODES, type ResolvedTheme, type ThemeMode } from '../theme';
import { IconCheck, IconMoon, IconSkull, IconSun, IconTerminal, type IconProps } from './icons';
import { useMenuKeys } from './ui';

const GLYPHS: Record<ThemeMode, ComponentType<IconProps>> = {
  system: IconSun,
  light: IconSun,
  dark: IconMoon,
  retro: IconTerminal,
  blackmetal: IconSkull,
};

export function ThemePicker({
  mode,
  resolved,
  onChange,
}: {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  onChange: (mode: ThemeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  // The button shows what is actually on screen, not the abstract "system".
  const Glyph = GLYPHS[resolved];
  const label = `Theme: ${THEME_MODES.find((item) => item.mode === mode)?.label}`;

  return (
    <div className="theme-picker" ref={ref}>
      <button
        className="btn icon"
        onClick={() => setOpen((value) => !value)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Glyph size={16} />
      </button>
      {open && <ThemeMenu mode={mode} onChange={onChange} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The open menu, mounted only while open so its keyboard handling starts fresh each time. */
function ThemeMenu({
  mode,
  onChange,
  onClose,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMenuKeys(ref, onClose);
  return (
    <div className="menu theme-menu" role="menu" aria-label="Theme" ref={ref}>
      <div className="heading">Theme</div>
      {THEME_MODES.map((item) => {
        const ItemGlyph = GLYPHS[item.mode];
        const current = mode === item.mode;
        return (
          <button
            key={item.mode}
            role="menuitemradio"
            aria-checked={current}
            onClick={() => {
              onChange(item.mode);
              onClose();
            }}
          >
            <span className="menu-icon">
              <ItemGlyph size={13} />
            </span>
            <span className="theme-label">
              {item.label}
              <span className="theme-hint">{item.hint}</span>
            </span>
            {current && <IconCheck size={13} className="theme-current" />}
          </button>
        );
      })}
    </div>
  );
}
