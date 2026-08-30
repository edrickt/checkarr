import type {
  FileListResponse,
  FileQuery,
  FileStatus,
  ScanRun,
  Settings,
  SettingsResponse,
  Source,
  Stats,
  SyncResponse,
  TestResult
} from "./types";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) msg = String(body.error);
    } catch {
      // keep default message
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function get<T>(url: string): Promise<T> {
  return fetch(url).then((r) => handle<T>(r));
}

function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  }).then((r) => handle<T>(r));
}

export interface SourceInput {
  type: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export const api = {
  settings: () => get<SettingsResponse>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) => send<{ settings: Settings }>("PUT", "/api/settings", patch),
  sources: () => get<{ sources: Source[] }>("/api/sources"),
  addSource: (s: SourceInput) => send<{ id: number }>("POST", "/api/sources", s),
  updateSource: (id: number, patch: Partial<SourceInput> & { enabled?: boolean }) =>
    send<{ ok: boolean }>("PUT", "/api/sources/" + id, patch),
  deleteSource: (id: number) => send<{ ok: boolean }>("DELETE", "/api/sources/" + id),
  testSource: (id: number) => send<TestResult>("POST", "/api/sources/" + id + "/test"),
  sync: (sourceId?: number) => send<SyncResponse>("POST", "/api/sync", sourceId !== undefined ? { sourceId } : {}),
  startScan: (mode: "quick" | "deep", scope: "unchecked" | "all") =>
    send<{ runId: number }>("POST", "/api/scan", { mode, scope }),
  cancelScan: () => send<{ ok: boolean }>("POST", "/api/scan/cancel"),
  currentScan: () => get<{ run: ScanRun | null; active: boolean }>("/api/scan/current"),
  stats: () => get<Stats>("/api/stats"),
  files: (params: FileQuery) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.sourceId) qs.set("sourceId", String(params.sourceId));
    if (params.q) qs.set("q", params.q);
    if (params.page) qs.set("page", String(params.page));
    if (params.pageSize) qs.set("pageSize", String(params.pageSize));
    if (params.sort) qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
    const encoded = qs.toString();
    return get<FileListResponse>("/api/files" + (encoded ? "?" + encoded : ""));
  },
  file: (id: number) => get<{ file: MediaFileDetail }>("/api/files/" + id),
  recheck: (id: number) =>
    send<{ id: number; status: FileStatus; detail: string | null }>("POST", "/api/files/" + id + "/recheck"),
  streamUrl: (id: number) => "/api/files/" + id + "/stream"
};

export interface MediaFileDetail {
  id: number;
  sourceId: number;
  sourceType: string;
  sourceName: string;
  kind: "movie" | "episode";
  title: string;
  subtitle: string | null;
  path: string;
  sizeBytes: number | null;
  quality: string | null;
  status: FileStatus;
  durationS: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  errorDetail: string | null;
  checkedAt: string | null;
  probe: { durationS: number | null; container: string | null; videoCodec: string | null; audioCodec: string | null } | null;
}
