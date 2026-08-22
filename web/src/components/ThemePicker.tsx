import { useEffect, useRef, useState } from 'react';
import { THEME_MODES, type ThemeMode } from '../theme';
import { IconCheck, IconMoon, IconSkull, IconSun, IconTerminal } from './icons';

const GLYPHS: Record<ThemeMode, (props: { size?: number }) => JSX.Element> = {
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
  resolved: string;
  onChange: (mode: ThemeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The button shows what is actually on screen, not the abstract "system".
  const Glyph = GLYPHS[resolved as ThemeMode] ?? IconMoon;

  return (
    <div className="theme-picker" ref={ref}>
      <button
        className="btn icon"
        onClick={() => setOpen((value) => !value)}
        title={`Theme: ${THEME_MODES.find((item) => item.mode === mode)?.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Glyph size={16} />
      </button>
      {open && (
        <div className="menu theme-menu" role="menu">
          <div className="heading">Theme</div>
          {THEME_MODES.map((item) => {
            const ItemGlyph = GLYPHS[item.mode];
            return (
              <button
                key={item.mode}
                role="menuitemradio"
                aria-checked={mode === item.mode}
                onClick={() => {
                  onChange(item.mode);
                  setOpen(false);
                }}
              >
                <span style={{ display: 'grid', placeItems: 'center', width: 16, flex: 'none' }}>
                  <ItemGlyph size={13} />
                </span>
                <span style={{ flex: 1 }}>
                  {item.label}
                  <span className="theme-hint">{item.hint}</span>
                </span>
                {mode === item.mode && <IconCheck size={13} style={{ color: 'var(--accent)' }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
