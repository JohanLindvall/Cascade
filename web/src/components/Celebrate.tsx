import { useEffect, useState } from 'react';

interface Piece {
  id: number;
  left: number;
  delay: number;
  duration: number;
  color: string;
  size: number;
  drift: number;
}

const COLORS = ['var(--accent)', 'var(--accent-2)', 'var(--ok)', 'var(--down)', 'var(--warn)'];

/**
 * Brief confetti burst when a download finishes. Deliberately short and
 * pointer-transparent; skipped entirely when the user prefers reduced motion.
 */
export function Celebrate({ trigger, onDone }: { trigger: number; onDone: () => void }) {
  const [pieces, setPieces] = useState<Piece[]>([]);

  useEffect(() => {
    if (!trigger) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone();
      return;
    }
    const batch: Piece[] = Array.from({ length: 26 }, (_, index) => ({
      id: trigger * 100 + index,
      left: 12 + Math.random() * 76,
      delay: Math.random() * 0.25,
      duration: 1.5 + Math.random() * 0.9,
      color: COLORS[index % COLORS.length],
      size: 5 + Math.random() * 5,
      drift: (Math.random() - 0.5) * 160,
    }));
    setPieces(batch);
    const timer = window.setTimeout(() => {
      setPieces([]);
      onDone();
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [trigger, onDone]);

  if (pieces.length === 0) return null;

  return (
    <div className="confetti" aria-hidden>
      {pieces.map((piece) => (
        <span
          key={piece.id}
          style={{
            left: `${piece.left}%`,
            width: piece.size,
            height: piece.size * 1.6,
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
