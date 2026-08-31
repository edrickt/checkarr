export type FileStatus =
  "unchecked" | "healthy" | "suspect" | "corrupt" | "missing" | "unreachable" | "purged";

/** Scan scopes mirror the statuses; there is no healthy scan (use "all"). */
export type ScanScope = Exclude<FileStatus, "healthy"> | "all";

/** Statuses Delete & re-search can target; "all" demands confirm: true. */
export type PurgeStatus = "corrupt" | "suspect" | "unreachable" | "all";

export interface MediaFile {
  id: number;
  sourceId: number;
  sourceType: string;
  sourceName: string;
  kind: "movie" | "episode";
  title: string;
  subtitle: string | null;
  /** null = monitored at the *arr with no file yet (missing). */
  path: string | null;
  sizeBytes: number | null;
  quality: string | null;
  status: FileStatus;
  durationS: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  errorDetail: string | null;
  checkedAt: string | null;
}

export interface Source {
  id: number;
  type: "radarr" | "sonarr";
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface PathMapping {
  match: string;
  replace: string;
}

export interface Settings {
  concurrency: number;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  pathMappings: PathMapping[];
}

export interface SettingsResponse {
  settings: Settings;
  resolved: { ffmpeg: string; ffprobe: string };
  ffmpegAvailable: boolean;
  ffmpegError: string | null;
}

export interface ScanRun {
  id: number;
  scope: string;
  sourceId: number | null;
  sourceName: string | null;
  state: string;
  total: number;
  done: number;
  issues: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface SourceStats {
  sourceId: number;
  total: number;
  byStatus: Record<string, number>;
}

export interface Stats {
  total: number;
  byStatus: Record<string, number>;
  bySource: SourceStats[];
  lastScan: ScanRun | null;
  activeScan: boolean;
}

export interface FileListResponse {
  items: MediaFile[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TestResult {
  ok: boolean;
  appName?: string;
  version?: string;
  mismatch?: boolean;
  error?: string;
}

export interface SyncResponse {
  results: {
    sourceId: number;
    name: string;
    ok: boolean;
    added?: number;
    relinked?: number;
    updated?: number;
    removed?: number;
    total?: number;
    error?: string;
  }[];
}

/** Per-source library sync summary attached to batch operations (they sync first). */
export interface BatchSyncSummary {
  sourceId: number;
  name: string;
  ok: boolean;
  added?: number;
  relinked?: number;
  updated?: number;
  removed?: number;
  total?: number;
  error?: string;
}

export interface PurgeResponse {
  results: {
    sourceId: number;
    name: string;
    type: string;
    deleted: number;
    searched: number;
    skipped: number;
    errors: string[];
  }[];
  total: number;
  /** The library sync that ran before the purge. */
  synced: BatchSyncSummary[];
}

export interface FileQuery {
  status?: string | null;
  sourceId?: number | null;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}
