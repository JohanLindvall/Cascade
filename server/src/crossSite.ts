/**
 * Refuse state-changing requests that a *different website* made the
 * browser send.
 *
 * The JSON endpoints are already out of a hostile page's reach: a
 * cross-site request with `content-type: application/json` needs a CORS
 * preflight, which this server never answers. `/api/torrents/upload` is not:
 * multipart/form-data is a "simple" request, so any page the owner visits
 * could post a form there and have their rtorrent fetch whatever magnet or
 * URL it liked — with Basic auth on, too, since the browser attaches cached
 * credentials to the form post.
 *
 * Browsers say where a request came from, and nothing else does:
 * `Sec-Fetch-Site` on every modern browser, `Origin` on older ones. Only
 * requests carrying one of those and naming another site are refused, so
 * curl, the Python xmlrpc client, the *arr apps and other non-browser
 * callers of /api and /RPC2 are untouched, and so are browser extensions
 * (their origin cannot be forged by a page).
 */

export interface RequestFacts {
  method: string;
  /** The Origin header, if any. */
  origin?: string;
  /** The Sec-Fetch-Site header, if any. */
  fetchSite?: string;
  /** The host the browser addressed: X-Forwarded-Host behind a proxy, else Host. */
  host?: string;
}

/** Methods that must not change state, and so need no check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Extension pages post as themselves; a web page cannot claim these schemes. */
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//i;

export function isCrossSiteRequest({ method, origin, fetchSite, host }: RequestFacts): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (origin && EXTENSION_ORIGIN.test(origin)) return false;
  // "none" is the user's own doing: a bookmark, the address bar, a drop.
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';
  if (origin) {
    try {
      return new URL(origin).host !== host;
    } catch {
      return true; // "null" and other opaque origins: a sandbox, never this page
    }
  }
  return false; // No browser markers at all: a script, not a page.
}
