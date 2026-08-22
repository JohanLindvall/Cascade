import path from 'node:path';
import { parseScgiTarget, type ScgiTarget } from './scgi';

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function normalizeBase(base: string): string {
  let value = base.trim();
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

const downloadDir = str('RT_DOWNLOAD_DIR', '/downloads');
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
  scgi: parseScgiTarget(str('CASCADE_SCGI', str('RT_SCGI_SOCKET', '/run/rtorrent/rpc.socket'))),
  host: str('WEB_HOST', '0.0.0.0'),
  port: num('WEB_PORT', 8080),
  basePath: normalizeBase(str('WEB_BASE_PATH', '/')),
  user: optional('WEB_USER'),
  password: optional('WEB_PASS'),
  webRoot: str('CASCADE_WEB_ROOT', path.join(__dirname, '..', 'web')),
  stateFile: str('CASCADE_STATE_FILE', '/config/cascade-state.json'),
  downloadDir,
  completedDir,
  deleteRoots,
  allowRawRpc: bool('CASCADE_ALLOW_RAW_RPC', true),
  allowDataDelete: bool('CASCADE_ALLOW_DATA_DELETE', true),
  maxUploadBytes: num('CASCADE_MAX_UPLOAD_MB', 64) * 1024 * 1024,
  pollIntervalMs: num('CASCADE_POLL_MS', 1000),
  logFile: str('RT_LOG_FILE', '/config/rtorrent.log'),
  bootSettingsFile: str('CASCADE_BOOT_SETTINGS', '/run/cascade/boot-settings.json'),
  gamify: bool('CASCADE_GAMIFY', true),
};
