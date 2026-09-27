/** The server's HTTP shapes (contracts.ts), under the names the components use. */
export type {
  TorrentStatus, Torrent, TorrentFile, Peer, Tracker,
  BackendSummary, Policy, RateSample, GlobalStatus, StateResponse,
  LogScopeState as LogScopes, ThrottleGroup,
  Tier, ProgressUnit, Achievement, GameStats, GameState, UploadResult,
} from './contracts';
import type { GlobalSettings } from './contracts';

/** A backend only reports the settings its command table supports. */
export type Settings = Partial<GlobalSettings>;
