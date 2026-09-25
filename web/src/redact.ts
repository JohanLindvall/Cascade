/**
 * Keep private-tracker credentials off the screen.
 *
 * A private tracker's announce URL carries the account's passkey — as a query
 * parameter (`/announce.php?passkey=…`, `?authkey=…&torrent_pass=…`) or as a
 * path segment (Gazelle's `/<32 hex>/announce`) — and rtorrent echoes those
 * URLs into its log. Anything that shows a tracker URL or a log line runs it
 * through here first, because screenshots, screen shares and a glance over a
 * shoulder all leak what the page shows, and a leaked passkey is an account
 * someone else can ratio on.
 *
 * Only URLs are touched. Info hashes appear bare throughout rtorrent's log
 * ("7848BD5C…->tracker_list: …") and must stay readable, so the rules below
 * never apply outside a `scheme://…` span.
 */

const MASK = '•••';

/** Query parameters that trackers use for credentials. */
const SECRET_PARAMS = new Set([
  'passkey',
  'authkey',
  'torrent_pass',
  'pk',
  'pid',
  'uid',
  'key',
  'token',
  'secret',
  'apikey',
  'api_key',
  'auth',
  'sig',
  'signature',
]);

/** A path segment that is one long opaque token: a passkey, not a word. */
const SECRET_SEGMENT = /^[A-Za-z0-9]{16,}$/;

/** scheme://authority, then path, query and fragment. */
const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** A URL inside running text: up to whitespace, a quote or an angle bracket. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;

/** One URL with its credentials masked; anything that is not a URL comes back as is. */
export function redactUrl(url: string): string {
  const parts = URL_PARTS.exec(url);
  if (!parts) return url;
  const [, authority, path, query = '', fragment = ''] = parts;
  // A user:password@ in the authority is a credential too.
  const host = authority.replace(/\/\/[^/@]*@/, `//${MASK}@`);
  const cleanPath = path
    .split('/')
    .map((segment) => (SECRET_SEGMENT.test(segment) ? MASK : segment))
    .join('/');
  const cleanQuery = query.replace(/([?&;])([^=&;]+)=([^&;]*)/g, (whole, sep: string, name: string) =>
    SECRET_PARAMS.has(name.toLowerCase()) ? `${sep}${name}=${MASK}` : whole,
  );
  return `${host}${cleanPath}${cleanQuery}${fragment}`;
}

/** Every URL in a piece of text redacted, the rest of it left alone. */
export function redactSecrets(text: string): string {
  return text.includes('://') ? text.replace(URL_IN_TEXT, redactUrl) : text;
}
