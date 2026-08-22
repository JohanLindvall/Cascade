import { useEffect, useRef, useState } from 'react';

type PieceKind = 'confetti' | 'ash' | 'ember';

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

/**
 * Brief flourish when a download finishes: confetti normally; in the black
 * metal theme, falling ash and embers under a lightning flash and a closing
 * pall. Deliberately short and pointer-transparent; skipped entirely when the
 * user prefers reduced motion.
 */
export function Celebrate({
  trigger,
  grim,
  onDone,
}: {
  trigger: number;
  /** Black metal theme: mourn instead of celebrating. */
  grim?: boolean;
  onDone: () => void;
}) {
  const [pieces, setPieces] = useState<Piece[]>([]);
  // Whether the batch in flight is the grim one — the container must keep the
  // look it started with even if the theme flips mid-fall.
  const [mourning, setMourning] = useState(false);
  // Held in refs so a parent re-render cannot restart the sequence mid-flight.
  const done = useRef(onDone);
  done.current = onDone;
  const grimRef = useRef(!!grim);
  grimRef.current = !!grim;

  useEffect(() => {
    if (!trigger) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done.current();
      return;
    }
    const isGrim = grimRef.current;
    setMourning(isGrim);
    setPieces(isGrim ? makeAshfall(trigger) : makeConfetti(trigger));
    const timer = window.setTimeout(
      () => {
        setPieces([]);
        done.current();
      },
      isGrim ? 5600 : 2600,
    );
    return () => window.clearTimeout(timer);
  }, [trigger]);

  if (pieces.length === 0) return null;

  return (
    <div className={mourning ? 'confetti grim' : 'confetti'} aria-hidden>
      {mourning && (
        <>
          <span className="grim-flash" />
          <span className="grim-pall" />
        </>
      )}
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
