import path from 'node:path';
import { documentedDefault } from './options';
import { parseScgiTarget, type ScgiTarget } from './scgi';

export interface Config {
  scgi: ScgiTarget;
  host: string;
  port: number;
  basePath: string;
  user?: string;
  password?: string;
  webRoot: string;
  stateFile: string;
  downloadDir: string;
  completedDir?: string;
  deleteRoots: string[];
  allowRawRpc: boolean;
  allowDataDelete: boolean;
  maxUploadBytes: number;
  pollIntervalMs: number;
  logFile: string;
  /** The scopes RT_LOG_LEVEL baked into rtorrent.rc at container start. */
  logLevel: string;
  bootSettingsFile: string;
  gamify: boolean;
}

const TRUTHY = /^(1|true|yes|on)$/i;

function normalizeBase(base: string): string {
  let value = base.trim();
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/+$/, '') || '/';
  if (value !== '/' && (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/.test(value) ||
      value.split('/').some((part) => part === '.' || part === '..'))) {
    throw new Error('WEB_BASE_PATH must be a URL path without traversal or route pattern characters');
  }
  return value;
}

/**
 * Read the configuration out of an environment.
 *
 * Every value comes from the catalog in options.ts: the readers below look
 * their default up by name, and that lookup throws for a name the catalog does
 * not list. An environment variable therefore cannot reach the server without
 * also appearing in `--help` and the README. (optionsdoc.ts scans this file
 * for the `str('NAME')` calls, so the reader names are part of that contract.)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === '' ? undefined : value;
  };
  const str = (name: string, fallback = documentedDefault(name) ?? ''): string =>
    raw(name) ?? fallback;
  const optional = (name: string): string | undefined => {
    documentedDefault(name); // Asserts the option is catalogued.
    return raw(name);
  };
  const num = (name: string, max = Number.MAX_SAFE_INTEGER): number => {
    const value = Number(raw(name) ?? documentedDefault(name));
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be a whole number from 1 to ${max}`);
    }
    return value;
  };
  // An option with no documented default reads as false rather than true, so a
  // new flag cannot arrive switched on by accident.
  const bool = (name: string, fallback = TRUTHY.test(documentedDefault(name) ?? '')): boolean => {
    const value = raw(name);
    return value === undefined ? fallback : TRUTHY.test(value);
  };

  const downloadDir = str('RT_DOWNLOAD_DIR');
  const completedDir = optional('RT_COMPLETED_DIR');
  const deleteRoots = [downloadDir, completedDir, ...str('CASCADE_DELETE_ROOTS', '').split(':')]
    .filter((value): value is string => !!value && value.trim() !== '')
    .map((value) => path.resolve(value));

  return {
    scgi: parseScgiTarget(str('CASCADE_SCGI', str('RT_SCGI_SOCKET'))),
    host: str('WEB_HOST'),
    port: num('WEB_PORT', 65535),
    basePath: normalizeBase(str('WEB_BASE_PATH')),
    user: optional('WEB_USER'),
    password: optional('WEB_PASS'),
    // Falls back to the sibling directory so a source checkout runs too.
    webRoot: path.resolve(str('CASCADE_WEB_ROOT', path.join(__dirname, '..', '..', 'web', 'dist'))),
    stateFile: str('CASCADE_STATE_FILE'),
    downloadDir,
    completedDir,
    deleteRoots,
    allowRawRpc: bool('CASCADE_ALLOW_RAW_RPC'),
    allowDataDelete: bool('CASCADE_ALLOW_DATA_DELETE'),
    maxUploadBytes: num('CASCADE_MAX_UPLOAD_MB', Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))) * 1024 * 1024,
    pollIntervalMs: num('CASCADE_POLL_MS', 2_147_483_647),
    logFile: str('RT_LOG_FILE'),
    logLevel: str('RT_LOG_LEVEL'),
    bootSettingsFile: str('CASCADE_BOOT_SETTINGS'),
    gamify: bool('CASCADE_GAMIFY'),
  };
}
