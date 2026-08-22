import { useEffect, useMemo, useRef, useState } from 'react';
import { IconFile } from './icons';

export interface Burst {
  id: number;
  x: number;
  y: number;
  count: number;
}

const SPARKS = 16;

const SHARD_COLORS = ['#9d968a', '#7a7568', 'var(--accent)', '#514d44', '#d4454f', '#8b857a'];

/**
 * Pickup animation for a torrent dropped on the window: a shockwave at the drop
 * point, sparks thrown outward, and the payload flying up into the Add button
 * like a collected power-up. In the black metal theme the drop is a summoning
 * instead — a cast sigil, ash and ember shards that fall as they die, and an
 * offering counted in carved caps. Purely decorative — the upload flow does not
 * wait on it, and it is skipped entirely under prefers-reduced-motion.
 */
export function DropBurst({
  burst,
  grim,
  onDone,
}: {
  burst: Burst | null;
  /** Black metal theme: summon rather than celebrate. */
  grim?: boolean;
  onDone: () => void;
}) {
  const [flight, setFlight] = useState({ dx: 0, dy: 0 });
  // The parent re-renders on every poll, so keep the callback out of the effect
  // deps — otherwise the sequence is torn down and restarted mid-flight.
  const done = useRef(onDone);
  done.current = onDone;

  // Lock the look in at launch so a theme flip cannot restyle a burst mid-air.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mourning = useMemo(() => !!grim, [burst?.id]);

  // Spark trajectories are fixed per burst so a re-render cannot reshuffle
  // them. The grim variant reuses them as shards, adding a terminal fall.
  const sparks = useMemo(
    () =>
      Array.from({ length: SPARKS }, (_, index) => {
        const angle = (index / SPARKS) * Math.PI * 2 + (index % 3) * 0.22;
        const distance = 70 + ((index * 37) % 70);
        return {
          dx: Math.cos(angle) * distance,
          dy: Math.sin(angle) * distance,
          fall: 44 + ((index * 29) % 52),
          delay: (index % 5) * 0.02,
          size: 5 + ((index * 13) % 5),
          spin: index % 2 ? 220 : -220,
          color: SHARD_COLORS[index % SHARD_COLORS.length],
          ember: index % 4 === 2,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [burst?.id],
  );

  useEffect(() => {
    if (!burst) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone();
      return;
    }

    // Fly towards the Add button, so the payload visibly lands where torrents
    // are added from.
    const target = document.querySelector('.header .btn.primary');
    const rect = target?.getBoundingClientRect();
    setFlight({
      dx: (rect ? rect.left + rect.width / 2 : window.innerWidth / 2) - burst.x,
      dy: (rect ? rect.top + rect.height / 2 : 30) - burst.y,
    });

    // Punch the button when the payload arrives.
    const land = window.setTimeout(() => target?.classList.add('hit'), 520);
    const unpunch = window.setTimeout(() => target?.classList.remove('hit'), 1000);
    const finish = window.setTimeout(() => done.current(), 1300);
    return () => {
      window.clearTimeout(land);
      window.clearTimeout(unpunch);
      window.clearTimeout(finish);
      target?.classList.remove('hit');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burst?.id]);

  if (!burst) return null;

  return (
    <div
      className={mourning ? 'drop-burst grim' : 'drop-burst'}
      style={{
        left: burst.x,
        top: burst.y,
        ['--dx' as string]: `${flight.dx}px`,
        ['--dy' as string]: `${flight.dy}px`,
      }}
      aria-hidden
    >
      {mourning ? (
        // A summoning circle cast at the point of impact.
        <svg className="burst-sigil" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" strokeWidth="1" />
          <path
            d="M50 88 L27.7 19.3 L86.1 61.7 L13.9 61.7 L72.3 19.3 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <>
          <span className="burst-ring" />
          <span className="burst-ring two" />
        </>
      )}
      <span className="burst-flash" />

      {sparks.map((spark, index) =>
        mourning ? (
          <span
            key={index}
            className={spark.ember ? 'burst-shard ember' : 'burst-shard'}
            style={{
              width: spark.size - 1,
              height: spark.size - 1,
              background: spark.color,
              animationDelay: `${spark.delay}s`,
              ['--sx' as string]: `${spark.dx}px`,
              ['--sy' as string]: `${spark.dy}px`,
              ['--fy' as string]: `${spark.fall}px`,
              ['--spin' as string]: `${spark.spin}deg`,
            }}
          />
        ) : (
          <span
            key={index}
            className="burst-spark"
            style={{
              width: spark.size,
              height: spark.size,
              animationDelay: `${spark.delay}s`,
              ['--sx' as string]: `${spark.dx}px`,
              ['--sy' as string]: `${spark.dy}px`,
              ['--spin' as string]: `${spark.spin}deg`,
            }}
          />
        ),
      )}

      <span className="burst-payload">
        <IconFile size={15} />
        {burst.count}
      </span>

      <span className="burst-score">
        {mourning
          ? `+${burst.count} offering${burst.count === 1 ? '' : 's'}`
          : `+${burst.count} torrent${burst.count === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}
