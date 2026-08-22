import path from 'node:path';
import { documentedDefault } from './options';
import { parseScgiTarget, type ScgiTarget } from './scgi';

/**
 * Every value here comes from the catalog in options.ts: the readers below look
 * their default up by name, and that lookup throws for a name the catalog does
 * not list. An environment variable therefore cannot reach the server without
 * also appearing in `--help` and the README.
 */
function raw(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function str(name: string, fallback = documentedDefault(name) ?? ''): string {
  return raw(name) ?? fallback;
}

function optional(name: string): string | undefined {
  documentedDefault(name); // Asserts the option is catalogued.
  return raw(name);
}

function num(name: string, fallback = Number(documentedDefault(name))): number {
  const value = Number(raw(name));
  return Number.isFinite(value) ? value : fallback;
}

const TRUTHY = /^(1|true|yes|on)$/i;

// An option with no documented default reads as false rather than true, so a
// new flag cannot arrive switched on by accident.
function bool(name: string, fallback = TRUTHY.test(documentedDefault(name) ?? '')): boolean {
  const value = raw(name);
  return value === undefined ? fallback : TRUTHY.test(value);
}

function normalizeBase(base: string): string {
  let value = base.trim();
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

const downloadDir = str('RT_DOWNLOAD_DIR');
const completedDir = optional('RT_COMPLETED_DIR');

const deleteRoots = [downloadDir, completedDir, ...str('CASCADE_DELETE_ROOTS', '').split(':')]
  .filter((value): value is string => !!value && value.trim() !== '')
  .map((value) => path.resolve(value));

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
  bootSettingsFile: string;
  gamify: boolean;
}

export const config: Config = {
  scgi: parseScgiTarget(str('CASCADE_SCGI', str('RT_SCGI_SOCKET'))),
  host: str('WEB_HOST'),
  port: num('WEB_PORT'),
  basePath: normalizeBase(str('WEB_BASE_PATH')),
  user: optional('WEB_USER'),
  password: optional('WEB_PASS'),
  // Falls back to the sibling directory so a source checkout runs too.
  webRoot: str('CASCADE_WEB_ROOT', path.join(__dirname, '..', 'web')),
  stateFile: str('CASCADE_STATE_FILE'),
  downloadDir,
  completedDir,
  deleteRoots,
  allowRawRpc: bool('CASCADE_ALLOW_RAW_RPC'),
  allowDataDelete: bool('CASCADE_ALLOW_DATA_DELETE'),
  maxUploadBytes: num('CASCADE_MAX_UPLOAD_MB') * 1024 * 1024,
  pollIntervalMs: num('CASCADE_POLL_MS'),
  logFile: str('RT_LOG_FILE'),
  bootSettingsFile: str('CASCADE_BOOT_SETTINGS'),
  gamify: bool('CASCADE_GAMIFY'),
};
