import { useEffect, useRef, useState } from 'react';
import type { FxFlavor } from '../theme';

type PieceKind = 'confetti' | 'ash' | 'ember' | 'pixel';

interface Piece {
  id: number;
  kind: PieceKind;
  left: number;
  delay: number;
  duration: number;
  color: string;
  size: number;
  drift: number;
}

const CONFETTI_COLORS = ['var(--accent)', 'var(--accent-2)', 'var(--ok)', 'var(--down)', 'var(--warn)'];
const ASH_COLORS = ['var(--text-dim)', 'var(--text-faint)', '#7a7568', '#514d44'];
const EMBER_COLORS = ['var(--accent)', '#d4454f', '#c9772e'];
const PIXEL_COLORS = ['#34ff9e', '#ff4fd8', '#35f0ff', '#ffd23f', '#d8ffe9'];

function makeConfetti(trigger: number): Piece[] {
  return Array.from({ length: 26 }, (_, index) => ({
    id: trigger * 100 + index,
    kind: 'confetti' as const,
    left: 12 + Math.random() * 76,
    delay: Math.random() * 0.25,
    duration: 1.5 + Math.random() * 0.9,
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    size: 5 + Math.random() * 5,
    drift: (Math.random() - 0.5) * 160,
  }));
}

/** The black metal completion: ash sinking slowly, a few embers among it. */
function makeAshfall(trigger: number): Piece[] {
  const ash = Array.from({ length: 30 }, (_, index) => ({
    id: trigger * 100 + index,
    kind: 'ash' as const,
    left: 4 + Math.random() * 92,
    delay: Math.random() * 1.1,
    duration: 2.8 + Math.random() * 1.6,
    color: ASH_COLORS[index % ASH_COLORS.length],
    size: 3 + Math.random() * 3.5,
    drift: (Math.random() - 0.5) * 90,
  }));
  const embers = Array.from({ length: 8 }, (_, index) => ({
    id: trigger * 100 + 60 + index,
    kind: 'ember' as const,
    left: 8 + Math.random() * 84,
    delay: Math.random() * 0.8,
    duration: 2.2 + Math.random() * 1.2,
    color: EMBER_COLORS[index % EMBER_COLORS.length],
    size: 2.5 + Math.random() * 2,
    drift: (Math.random() - 0.5) * 130,
  }));
  return [...ash, ...embers];
}

/** The retro completion: chunky phosphor pixels raining in stepped motion. */
function makePixels(trigger: number): Piece[] {
  return Array.from({ length: 28 }, (_, index) => ({
    id: trigger * 100 + index,
    kind: 'pixel' as const,
    left: 6 + Math.random() * 88,
    delay: Math.random() * 0.35,
    duration: 1.6 + Math.random() * 0.9,
    color: PIXEL_COLORS[index % PIXEL_COLORS.length],
    size: 6 + Math.floor(Math.random() * 3) * 2,
    // Snapped to a coarse grid so the sideways motion also lands on "pixels".
    drift: (Math.floor(Math.random() * 9) - 4) * 24,
  }));
}

const FLAVOR_PIECES: Record<FxFlavor, (trigger: number) => Piece[]> = {
  party: makeConfetti,
  grim: makeAshfall,
  arcade: makePixels,
};

const FLAVOR_DURATION: Record<FxFlavor, number> = { party: 2600, grim: 5600, arcade: 2900 };

/**
 * Brief flourish when a download finishes: confetti normally; falling ash and
 * embers under a lightning flash and a closing pall in the black metal theme;
 * a stepped pixel rain with a CRT flicker in retro. Deliberately short and
 * pointer-transparent; skipped entirely when the user prefers reduced motion.
 */
export function Celebrate({
  trigger,
  flavor = 'party',
  onDone,
}: {
  trigger: number;
  flavor?: FxFlavor;
  onDone: () => void;
}) {
  const [pieces, setPieces] = useState<Piece[]>([]);
  // The flavor the batch in flight was launched with — the sequence must keep
  // the look it started with even if the theme flips mid-fall.
  const [shown, setShown] = useState<FxFlavor>('party');
  // Held in refs so a parent re-render cannot restart the sequence mid-flight.
  const done = useRef(onDone);
  done.current = onDone;
  const flavorRef = useRef(flavor);
  flavorRef.current = flavor;

  useEffect(() => {
    if (!trigger) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done.current();
      return;
    }
    const launched = flavorRef.current;
    setShown(launched);
    setPieces(FLAVOR_PIECES[launched](trigger));
    const timer = window.setTimeout(() => {
      setPieces([]);
      done.current();
    }, FLAVOR_DURATION[launched]);
    return () => window.clearTimeout(timer);
  }, [trigger]);

  if (pieces.length === 0) return null;

  return (
    <div className={shown === 'party' ? 'confetti' : `confetti ${shown}`} aria-hidden>
      {shown === 'grim' && (
        <>
          <span className="grim-flash" />
          <span className="grim-pall" />
        </>
      )}
      {shown === 'arcade' && <span className="arcade-flash" />}
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className={piece.kind}
          style={{
            left: `${piece.left}%`,
            width: piece.size,
            height: piece.kind === 'confetti' ? piece.size * 1.6 : piece.size,
            background: piece.color,
            animationDelay: `${piece.delay}s`,
            animationDuration: `${piece.duration}s`,
            ['--drift' as string]: `${piece.drift}px`,
          }}
        />
      ))}
    </div>
  );
}
