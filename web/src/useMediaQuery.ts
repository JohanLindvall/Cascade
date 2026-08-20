import { useEffect, useState } from 'react';

/** Subscribe to a media query, so layout decisions that CSS cannot express
 *  (rendering a different component) follow the same breakpoints. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);

  return matches;
}

/** Breakpoints shared between the hook and the stylesheet. */
export const COMPACT_QUERY = '(max-width: 720px)';
export const TABLET_QUERY = '(max-width: 1024px)';
