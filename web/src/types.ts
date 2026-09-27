/** Shared HTTP shapes: changes to a server response are checked by both builds. */
export type {
  TorrentStatus, Torrent, TorrentFile, Peer, Tracker,
  BackendSummary, Policy, RateSample, GlobalStatus, StateResponse,
  LogScopeState as LogScopes, ThrottleGroup,
  Tier, ProgressUnit, Achievement, GameStats, GameState, UploadResult,
} from '../../server/src/contracts';
import type { GlobalSettings } from '../../server/src/contracts';

/** A backend only reports the settings its command table supports. */
export type Settings = Partial<GlobalSettings>;
