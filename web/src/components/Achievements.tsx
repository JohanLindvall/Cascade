import { bytes, duration, timestamp } from '../format';
import type { Achievement, GameState } from '../types';
import {
  IconBolt,
  IconClock,
  IconDown,
  IconMedal,
  IconStar,
  IconTag,
  IconTarget,
  IconTrophy,
  IconUp,
  IconUsers,
} from './icons';
import { Modal } from './ui';

const ICONS: Record<string, (props: { size?: number }) => JSX.Element> = {
  trophy: IconTrophy,
  medal: IconMedal,
  bolt: IconBolt,
  target: IconTarget,
  star: IconStar,
  clock: IconClock,
  users: IconUsers,
  tag: IconTag,
  upload: IconUp,
  download: IconDown,
};

export function BadgeIcon({ icon, size = 18 }: { icon: string; size?: number }) {
  const Glyph = ICONS[icon] ?? IconTrophy;
  return <Glyph size={size} />;
}

/** Render progress in the same unit the target is expressed in. */
function describeProgress(item: Achievement): string {
  if (item.target >= 1024 * 1024) {
    return `${bytes(item.current)} / ${bytes(item.target)}`;
  }
  if (item.id === 'marathon') {
    return `${duration(item.current)} / ${duration(item.target)}`;
  }
  if (item.target === 1 && item.id === 'break-even') {
    return `${item.current.toFixed(2)} / 1.00`;
  }
  if (item.id === 'overachiever') {
    return `${item.current.toFixed(2)} / ${item.target.toFixed(2)}`;
  }
  return `${Math.floor(item.current)} / ${item.target}`;
}

export function AchievementsDialog({
  game,
  grim,
  onClose,
}: {
  game: GameState;
  /** Black metal theme: the copy is re-carved (see grim.ts). */
  grim?: boolean;
  onClose: () => void;
}) {
  const sorted = [...game.achievements].sort((a, b) => {
    const aDone = a.unlockedAt !== null ? 0 : 1;
    const bDone = b.unlockedAt !== null ? 0 : 1;
    if (aDone !== bDone) return aDone - bDone;
    return b.current / b.target - a.current / a.target;
  });

  const ratio =
    game.stats.lifetimeDown > 0 ? game.stats.lifetimeUp / game.stats.lifetimeDown : 0;

  return (
    <Modal
      title={grim ? 'The Grimoire' : 'Progress'}
      wide
      onClose={onClose}
      footer={
        <>
          <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
            Counted from real transfer totals · turn this off with CASCADE_GAMIFY=0
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="level-card">
        <div className="level-ring">
          <span>{game.level}</span>
        </div>
        <div className="level-meta">
          <div className="level-title">
            {game.title}
            <span className="level-xp num">{game.xp.toLocaleString()} XP</span>
          </div>
          <div className="bar level-bar">
            <i style={{ width: `${Math.min(100, game.progress * 100)}%` }} />
          </div>
          <div className="level-next num">
            {(game.nextLevelXp - game.xp).toLocaleString()} XP to level {game.level + 1}
          </div>
        </div>
        <div className="level-stats">
          <div>
            <span>Uploaded</span>
            <b>{bytes(game.stats.lifetimeUp)}</b>
          </div>
          <div>
            <span>Downloaded</span>
            <b>{bytes(game.stats.lifetimeDown)}</b>
          </div>
          <div>
            <span>Lifetime ratio</span>
            <b>{ratio.toFixed(2)}</b>
          </div>
          <div>
            <span>Completed</span>
            <b>{game.stats.completed}</b>
          </div>
        </div>
      </div>

      <div className="section">
        <h3>
          {grim ? 'Sigils' : 'Badges'} — {game.unlocked} of {game.total}
        </h3>
        <div className="badge-grid">
          {sorted.map((item) => {
            const done = item.unlockedAt !== null;
            const pct = Math.min(1, item.target > 0 ? item.current / item.target : 0);
            return (
              <div key={item.id} className={`badge ${item.tier} ${done ? 'earned' : 'locked'}`}>
                <div className="badge-medal">
                  <BadgeIcon icon={item.icon} size={17} />
                </div>
                <div className="badge-body">
                  <div className="badge-title">{item.title}</div>
                  <div className="badge-desc">{item.description}</div>
                  {done ? (
                    <div className="badge-meta num">Earned {timestamp(item.unlockedAt as number)}</div>
                  ) : (
                    <>
                      <div className="bar badge-bar">
                        <i style={{ width: `${pct * 100}%` }} />
                      </div>
                      <div className="badge-meta num">{describeProgress(item)}</div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/** Compact level indicator for the header. */
export function LevelChip({ game, onClick }: { game: GameState; onClick: () => void }) {
  return (
    <button
      className="level-chip"
      onClick={onClick}
      title={`${game.title} · ${game.xp.toLocaleString()} XP · ${game.unlocked}/${game.total} badges`}
    >
      <span className="level-chip-num">{game.level}</span>
      <span className="level-chip-body">
        <span className="level-chip-title">{game.title}</span>
        <span className="bar level-chip-bar">
          <i style={{ width: `${Math.min(100, game.progress * 100)}%` }} />
        </span>
      </span>
    </button>
  );
}
