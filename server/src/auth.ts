import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still compare to keep the timing profile flat.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** HTTP Basic auth, enabled only when WEB_USER and WEB_PASS are both set. */
export function basicAuth(config: Config) {
  const enabled = !!config.user && !!config.password;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) return next();
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const index = decoded.indexOf(':');
      const user = index < 0 ? decoded : decoded.slice(0, index);
      const pass = index < 0 ? '' : decoded.slice(index + 1);
      if (safeEqual(user, config.user as string) && safeEqual(pass, config.password as string)) {
        return next();
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Cascade", charset="UTF-8"');
    res.status(401).type('text/plain').send('authentication required');
  };
}
