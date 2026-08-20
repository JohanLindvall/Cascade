import { bytes, rate } from '../format';
import type { GameState, GlobalStatus } from '../types';
import { LevelChip } from './Achievements';
import {
  IconDown,
  IconGauge,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
  IconTerminal,
  IconUp,
} from './icons';
import { Sparkline } from './ui';

interface HeaderProps {
  status: GlobalStatus | null;
  game: GameState | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onAdd: () => void;
  onSettings: () => void;
  onThrottles: () => void;
  onConsole: () => void;
  onProgress: () => void;
}

export function Header({
  status,
  game,
  theme,
  onToggleTheme,
  onAdd,
  onSettings,
  onThrottles,
  onConsole,
  onProgress,
}: HeaderProps) {
  const history = status?.history ?? [];
  const down = history.map((sample) => sample.down);
  const up = history.map((sample) => sample.up);

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">
          <IconDown size={16} />
        </span>
        <span>
          Cascade
          <br />
          <small>{status?.backend.clientVersion ? `rtorrent ${status.backend.clientVersion}` : 'connecting…'}</small>
        </span>
      </div>

      <button className="btn primary" onClick={onAdd}>
        <IconPlus size={15} />
        Add torrent
      </button>

      <div className="header-spacer" />

      {game?.enabled && <LevelChip game={game} onClick={onProgress} />}

      <div className="rate-cluster">
        <Sparkline down={down} up={up} />
        <div className="rate down">
          <span className="rate-icon">
            <IconDown size={13} />
          </span>
          <span className="rate-value">
            <b>{rate(status?.downRate ?? 0)}</b>
            <span>{bytes(status?.downTotal ?? 0)} total</span>
          </span>
        </div>
        <div className="rate up">
          <span className="rate-icon">
            <IconUp size={13} />
          </span>
          <span className="rate-value">
            <b>{rate(status?.upRate ?? 0)}</b>
            <span>{bytes(status?.upTotal ?? 0)} total</span>
          </span>
        </div>
      </div>

      <button className="btn icon" onClick={onThrottles} title="Throttle groups">
        <IconGauge size={16} />
      </button>
      <button className="btn icon" onClick={onConsole} title="rtorrent API console">
        <IconTerminal size={16} />
      </button>
      <button className="btn icon" onClick={onSettings} title="rtorrent settings">
        <IconSettings size={16} />
      </button>
      <button className="btn icon" onClick={onToggleTheme} title="Toggle theme">
        {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
      </button>
    </header>
  );
}
