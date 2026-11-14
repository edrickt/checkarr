import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { ENV_HOST, isBroadcastHost, PORT } from "./config.js";
import { getSettings, saveSettings, type AppSettings, type PathMapping } from "./settings.js";
import { binariesUsable, resolveBinaries } from "./services/ffmpeg.js";
import { checkMediaFile, resolveLocalPath, type CheckOutcome } from "./services/checker.js";
import { persistCheckOutcome, ScanManager, type ScanScope } from "./services/scanner.js";
import {
  fetchArr,
  syncOneItem,
  syncSource,
  testSource,
  type ItemSyncResult,
  type SourceCore,
  type SyncResult
} from "./services/sync.js";
import { purgeFiles } from "./services/purge.js";
import { researchMissing, type ResearchStatus } from "./services/research.js";
import { ApiError } from "./lib/api-error.js";
import type { DB } from "./db.js";

interface SourceRow extends SourceCore {
  enabled: number;
  last_sync_at: string | null;
  last_sync_error: string | null;
}

function allDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (ch < "0" || ch > "9") return false;
  return true;
}

/** Parse a query value as a positive safe integer, or fall back. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

function escapeLike(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "%" || ch === "_" || ch === "!") out += "!" + ch;
    else out += ch;
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
  ".ts": "video/mp2t",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".flv": "video/x-flv",
  ".ogv": "video/ogg"
};

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

type RangeSpec = { start: number; end: number } | "full" | "invalid";

function parseRange(range: string | undefined, size: number): RangeSpec {
  if (!range) return "full";
  if (!range.startsWith("bytes=")) return "invalid";
  const spec = range.slice(6);
  const dash = spec.indexOf("-");
  if (dash < 0) return "invalid";
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  if (startStr === "") {
    if (!allDigits(endStr)) return "invalid";
    const n = Number(endStr);
    if (!(n > 0)) return "invalid";
    const start = Math.max(0, size - n);
    // Same validity rule as the explicit-range branch: a 0-byte file (a
    // truncated download) must answer 416, not hand createReadStream
    // start=0, end=-1, which throws a 500.
    if (start > size - 1 || start >= size) return "invalid";
    return { start, end: size - 1 };
  }
  if (!allDigits(startStr)) return "invalid";
  const start = Number(startStr);
  if (endStr === "") {
    if (start >= size) return "invalid";
    return { start, end: size - 1 };
  }
  if (!allDigits(endStr)) return "invalid";
  const end = Math.min(Number(endStr), size - 1);
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

function maskKey(key: string): string {
  return key.length <= 4 ? "\u2022\u2022\u2022\u2022" : "\u2022\u2022\u2022\u2022" + key.slice(-4);
}

/** Lets the API report - and trigger - a restart of the HTTP listener. */
export interface ServerControl {
  bindHost(): string;
  restart(): Promise<void>;
}

export function registerApi(app: FastifyInstance, db: DB, scans: ScanManager, server: ServerControl): void {
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error;
    if (err instanceof ApiError) return reply.code(err.statusCode).send({ error: err.message });
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: e.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  const getSource = (rawId: unknown): SourceRow => {
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid source id");
    const row = db
      .prepare(
        "SELECT id, type, name, base_url, api_key, enabled, last_sync_at, last_sync_error FROM sources WHERE id = ?"
      )
      .get(id) as unknown as SourceRow | undefined;
    if (!row) throw new ApiError(404, "source not found");
    return row;
  };

  // ---- batch-operation gate ----
  // Scan, sync, bulk delete and re-search all sync the library and then act on
  // it. Those operations must never overlap: a sync (or a delete!) landing
  // while a scan is starting would act on a different library than the scan
  // selected, and two requests could both sync before either claims the scan
  // slot. The gate is claimed synchronously - before any await - so the second
  // request is refused before it touches the network, and the claim covers a
  // scan's own pre-sync window. It is released in a finally block.
  let batchOperation: string | null = null;
  const runBatch = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (batchOperation !== null) {
      throw new ApiError(
        409,
        "another library operation (" + batchOperation + ") is running - wait for it to finish"
      );
    }
    batchOperation = name;
    try {
      return await fn();
    } finally {
      batchOperation = null;
    }
  };

  // Cancel must also work while a scan is still preparing: it syncs the
  // library before the ScanManager run exists, and a Cancel click in that
  // window used to be silently ignored (the scan then started anyway).
  let pendingScan: { cancelled: boolean } | null = null;

  // ---- single-item operations sync first ----
  // The *arr is the source of truth, and a media_files row can be stale: a
  // movie downloaded after the last library sync still sits here with no
  // path ('missing'), a file may have been replaced or removed entirely.
  // Every per-file operation therefore refreshes its row from the *arr
  // before acting - the single-item equivalent of "Sync libraries" - so a
  // re-check can pick a new download up and a delete cannot act on a path
  // the *arr no longer points at.
  interface FileWithSource {
    id: number;
    external_id: string;
    source_id: number;
    source_enabled: number;
    source_type: string;
    source_name: string;
    source_base_url: string;
    source_api_key: string;
  }
  const getFileWithSource = (rawId: unknown): FileWithSource | undefined => {
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid file id");
    return db
      .prepare(
        "SELECT mf.id, mf.external_id, s.id AS source_id, s.enabled AS source_enabled, s.type AS source_type," +
          " s.name AS source_name, s.base_url AS source_base_url, s.api_key AS source_api_key" +
          " FROM media_files mf JOIN sources s ON s.id = mf.source_id WHERE mf.id = ?"
      )
      .get(id) as FileWithSource | undefined;
  };
  const syncSingleItem = async (file: FileWithSource, operation: string): Promise<ItemSyncResult> => {
    const source: SourceCore = {
      id: file.source_id,
      type: file.source_type,
      name: file.source_name,
      base_url: file.source_base_url,
      api_key: file.source_api_key
    };
    try {
      return await syncOneItem(db, source, { id: file.id, externalId: file.external_id });
    } catch (err) {
      throw new ApiError(
        502,
        "cannot sync '" +
          file.source_name +
          "' from the *arr before " +
          operation +
          ": " +
          String((err as Error)?.message ?? err)
      );
    }
  };

  // ---- batch operations sync first ----
  // Scans and bulk deletes select and act on rows by what the DB says, so a
  // library synced hours ago means stale verdicts: files that landed in the
  // meantime are skipped, files that left are checked and deleted on stale
  // paths. Every batch operation therefore runs the same library sync the
  // "Sync libraries" button does (all enabled sources, or just the scoped
  // one) before it starts. A source that fails to sync aborts the batch -
  // acting on a half-stale library is the bug this prevents - while the
  // sources that synced before the failure keep their refresh.
  interface BatchSyncResult extends SyncResult {
    sourceId: number;
    name: string;
    ok: boolean;
    error?: string;
  }
  const syncSourcesForBatch = async (
    sourceId: number | undefined,
    operation: string
  ): Promise<BatchSyncResult[]> => {
    const sources: SourceRow[] =
      sourceId !== undefined
        ? [getSource(sourceId)] // explicit scope: sync it even when disabled, like /api/sync does
        : (db
            .prepare(
              "SELECT id, type, name, base_url, api_key, enabled, last_sync_at, last_sync_error" +
                " FROM sources WHERE enabled = 1 ORDER BY id"
            )
            .all() as unknown as SourceRow[]);
    if (sources.length === 0) {
      throw new ApiError(
        400,
        "no enabled sources to sync before " + operation + " - enable a source in Settings"
      );
    }
    const results: BatchSyncResult[] = [];
    const failures: string[] = [];
    for (const s of sources) {
      try {
        results.push({ sourceId: s.id, name: s.name, ok: true, ...(await syncSource(db, s)) });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        db.prepare("UPDATE sources SET last_sync_error = ? WHERE id = ?").run(msg, s.id);
        results.push({
          sourceId: s.id,
          name: s.name,
          ok: false,
          added: 0,
          relinked: 0,
          updated: 0,
          removed: 0,
          total: 0,
          error: msg
        });
        failures.push(s.name + ": " + msg);
      }
    }
    if (failures.length > 0) {
      throw new ApiError(502, "cannot sync the library before " + operation + " - " + failures.join("; "));
    }
    return results;
  };

  // ---- settings ----
  // Spawning ffmpeg -version on every settings read is process churn (the
  // dashboard fetches this page state); cache the verdict per binary pair.
  let binaryCheck: { key: string; problem: string | null; at: number } | null = null;
  app.get("/api/settings", async () => {
    const settings = getSettings(db);
    const binaries = resolveBinaries(settings);
    const key = binaries.ffmpeg + "\n" + binaries.ffprobe;
    if (binaryCheck === null || binaryCheck.key !== key || Date.now() - binaryCheck.at > 60_000) {
      binaryCheck = { key, problem: await binariesUsable(binaries), at: Date.now() };
    }
    const problem = binaryCheck.problem;
    const host = server.bindHost();
    return {
      settings,
      resolved: { ffmpeg: binaries.ffmpeg, ffprobe: binaries.ffprobe },
      ffmpegAvailable: problem === null,
      ffmpegError: problem,
      server: {
        port: PORT,
        host,
        broadcasting: isBroadcastHost(host),
        // An explicit HOST env var (Docker) overrides the settings toggle.
        hostFromEnv: ENV_HOST !== null
      }
    };
  });

  app.put("/api/settings", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<AppSettings> = {};
    if (body.concurrency !== undefined) {
      const c = Number(body.concurrency);
      if (!Number.isInteger(c) || c < 1 || c > 32)
        throw new ApiError(400, "concurrency must be an integer between 1 and 32");
      patch.concurrency = c;
    }
    if (body.ffmpegPath !== undefined)
      patch.ffmpegPath = body.ffmpegPath === null || body.ffmpegPath === "" ? null : String(body.ffmpegPath);
    if (body.ffprobePath !== undefined)
      patch.ffprobePath =
        body.ffprobePath === null || body.ffprobePath === "" ? null : String(body.ffprobePath);
    if (body.pathMappings !== undefined) {
      if (!Array.isArray(body.pathMappings)) throw new ApiError(400, "pathMappings must be an array");
      if (body.pathMappings.length > 50) throw new ApiError(400, "too many path mappings (max 50)");
      const mappings: PathMapping[] = [];
      for (const raw of body.pathMappings) {
        const m = (raw ?? {}) as Record<string, unknown>;
        if (typeof m.match !== "string" || m.match.length === 0 || typeof m.replace !== "string") {
          throw new ApiError(400, "each path mapping needs non-empty 'match' and 'replace' strings");
        }
        mappings.push({ match: m.match, replace: m.replace });
      }
      patch.pathMappings = mappings;
    }
    if (body.localBroadcast !== undefined) {
      if (typeof body.localBroadcast !== "boolean")
        throw new ApiError(400, "localBroadcast must be a boolean");
      if (ENV_HOST !== null && body.localBroadcast !== getSettings(db).localBroadcast) {
        throw new ApiError(400, "localBroadcast is overridden by the HOST environment variable");
      }
      patch.localBroadcast = body.localBroadcast;
    }
    const settings = saveSettings(db, patch);
    return { settings };
  });

  // ---- restart ----
  let restarting = false;
  app.post("/api/restart", async () => {
    if (restarting) throw new ApiError(409, "a restart is already in progress");
    restarting = true;
    // Reply first, then bounce the listener once the response is out -
    // closing immediately would race the client's own request. The restart
    // re-reads the local-broadcast toggle, so a freshly saved setting takes
    // effect here. Scans live in this process and keep running.
    setTimeout(() => {
      server
        .restart()
        .then(() => {
          restarting = false;
          app.log.info({ host: server.bindHost(), port: PORT }, "restarted listener");
        })
        .catch((err) => {
          restarting = false;
          app.log.error(err);
        });
    }, 250);
    return { ok: true };
  });

  // ---- sources ----
  app.get("/api/sources", async () => {
    const rows = db
      .prepare(
        "SELECT id, type, name, base_url AS baseUrl, api_key AS apiKey, enabled," +
          " last_sync_at AS lastSyncAt, last_sync_error AS lastSyncError, created_at AS createdAt FROM sources ORDER BY id"
      )
      .all() as { apiKey: string; [key: string]: unknown }[];
    // Keys are stealable through any read path; hand out a masked form and
    // let PUT treat the masked value as "unchanged".
    return {
      sources: rows.map(({ apiKey, ...rest }) => ({ ...rest, apiKey: maskKey(String(apiKey ?? "")) }))
    };
  });

  app.post("/api/sources", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const type = String(b.type ?? "");
    if (type !== "radarr" && type !== "sonarr") throw new ApiError(400, "type must be 'radarr' or 'sonarr'");
    const name = String(b.name ?? "").trim();
    if (!name) throw new ApiError(400, "name is required");
    const baseUrl = String(b.baseUrl ?? "").trim();
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      throw new ApiError(400, "baseUrl must start with http:// or https://");
    }
    const apiKey = String(b.apiKey ?? "").trim();
    if (!apiKey) throw new ApiError(400, "apiKey is required");
    const res = db
      .prepare("INSERT INTO sources (type, name, base_url, api_key) VALUES (?, ?, ?, ?)")
      .run(type, name, baseUrl, apiKey);
    return { id: Number(res.lastInsertRowid) };
  });

  app.put("/api/sources/:id", async (req) => {
    const source = getSource((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = b.name !== undefined ? String(b.name).trim() : source.name;
    if (!name) throw new ApiError(400, "name is required");
    const baseUrl = b.baseUrl !== undefined ? String(b.baseUrl).trim() : source.base_url;
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      throw new ApiError(400, "baseUrl must start with http:// or https://");
    }
    const apiKey = b.apiKey !== undefined ? String(b.apiKey).trim() : source.api_key;
    if (!apiKey) throw new ApiError(400, "apiKey is required");
    // The list endpoint hands back a masked key; saving it back unchanged
    // must keep the stored secret, not replace it with the mask.
    const storedKey = apiKey === maskKey(source.api_key) ? source.api_key : apiKey;
    let enabled: number;
    if (b.enabled === undefined) enabled = Number(source.enabled);
    else if (b.enabled === true || b.enabled === 1 || b.enabled === "true") enabled = 1;
    else if (b.enabled === false || b.enabled === 0 || b.enabled === "false") enabled = 0;
    else throw new ApiError(400, "enabled must be a boolean");
    db.prepare("UPDATE sources SET name = ?, base_url = ?, api_key = ?, enabled = ? WHERE id = ?").run(
      name,
      baseUrl,
      storedKey,
      enabled,
      source.id
    );
    return { ok: true };
  });

  app.delete("/api/sources/:id", async (req) => {
    const source = getSource((req.params as { id: string }).id);
    db.prepare("DELETE FROM sources WHERE id = ?").run(source.id);
    return { ok: true };
  });

  app.post("/api/sources/:id/test", async (req) => {
    const source = getSource((req.params as { id: string }).id);
    return testSource(source.type, source.base_url, source.api_key);
  });

  // ---- sync ----
  app.post("/api/sync", async (req) => {
    // Same gate as purge: a sync mid-scan can relink or clear rows the
    // scanner is mid-flight on, so scans and syncs never overlap.
    return runBatch("sync", async () => {
      if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
      const b = (req.body ?? {}) as { sourceId?: unknown };
      let sources: SourceRow[];
      if (b.sourceId !== undefined) {
        sources = [getSource(b.sourceId)];
      } else {
        sources = db
          .prepare(
            "SELECT id, type, name, base_url, api_key, enabled, last_sync_at, last_sync_error FROM sources WHERE enabled = 1 ORDER BY id"
          )
          .all() as unknown as SourceRow[];
      }
      if (sources.length === 0) throw new ApiError(400, "no sources to sync");
      const results: Array<Record<string, unknown>> = [];
      for (const s of sources) {
        try {
          const r = await syncSource(db, s);
          results.push({ sourceId: s.id, name: s.name, ok: true, ...r });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          db.prepare("UPDATE sources SET last_sync_error = ? WHERE id = ?").run(msg, s.id);
          results.push({ sourceId: s.id, name: s.name, ok: false, error: msg });
        }
      }
      return { results };
    });
  });

  // ---- purge ----
  const PURGE_STATUSES = ["corrupt", "suspect", "missing", "unreachable", "healthy", "unchecked", "all"];

  app.post("/api/purge", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // A missing status may keep the historical "corrupt" default, but a value
    // that is present must be a documented status: a wrong-typed value (an
    // array, a number, null) must be a 400 instead of silently falling back to
    // the destructive default.
    const status = b.status === undefined ? "corrupt" : b.status;
    if (typeof status !== "string" || !PURGE_STATUSES.includes(status))
      throw new ApiError(400, "status must be one of: " + PURGE_STATUSES.join(", "));
    // "all"/"healthy" delete good media, not just broken files: demand an
    // explicit opt-in so a stray or CSRF'd request cannot wipe a library.
    if ((status === "all" || status === "healthy") && b.confirm !== true) {
      throw new ApiError(
        400,
        "purging '" + status + "' deletes files that may be fine - send { confirm: true } to proceed"
      );
    }
    let sourceId: number | undefined;
    if (b.sourceId !== undefined && b.sourceId !== null) {
      sourceId = Number(b.sourceId);
      if (!Number.isInteger(sourceId)) throw new ApiError(400, "sourceId must be an integer");
      getSource(sourceId); // 404 when the source does not exist
    }
    return runBatch("delete", async () => {
      if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
      // Sync first, then delete: the status selection and the path checks must
      // reflect what the *arr reports now, not what the last manual sync saw.
      const synced = await syncSourcesForBatch(sourceId, "delete");
      const result = await purgeFiles(db, { status, sourceId });
      return { ...result, synced };
    });
  });

  // ---- research missing ----
  // Queue interactive searches at the *arr for items waiting on a download:
  // 'missing' rows (monitored, not downloaded) by default, or 'purged' rows
  // whose replacement search is still pending. Non-destructive, but it still
  // syncs first so the selected status reflects what the *arr reports now: a
  // freshly downloaded file must not be searched for, and a removed item must
  // not be searched for either.
  const RESEARCH_STATUSES: ResearchStatus[] = ["missing", "purged"];
  app.post("/api/research", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // A missing status may keep the historical 'missing' default, but a value
    // that is present must be one of the waiting statuses: a wrong-typed value
    // (an array, a number, null) must be a 400 instead of silently searching
    // rows the caller did not ask for.
    const status = b.status === undefined ? "missing" : b.status;
    if (typeof status !== "string" || !RESEARCH_STATUSES.includes(status as ResearchStatus))
      throw new ApiError(400, "status must be one of: " + RESEARCH_STATUSES.join(", "));
    let sourceId: number | undefined;
    if (b.sourceId !== undefined && b.sourceId !== null) {
      sourceId = Number(b.sourceId);
      if (!Number.isInteger(sourceId)) throw new ApiError(400, "sourceId must be an integer");
      getSource(sourceId); // 404 when the source does not exist
    }
    return runBatch("re-search", async () => {
      if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
      const syncOp = "re-search " + status;
      const synced = await syncSourcesForBatch(sourceId, syncOp);
      const result = await researchMissing(db, { sourceId, status: status as ResearchStatus });
      return { ...result, synced };
    });
  });

  // ---- scan ----
  const SCAN_SCOPES: ScanScope[] = [
    "unchecked",
    "corrupt",
    "suspect",
    "missing",
    "unreachable",
    "purged",
    "all"
  ];
  app.post("/api/scan", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.scope !== undefined && !SCAN_SCOPES.includes(b.scope as ScanScope)) {
      throw new ApiError(400, "scope must be one of: " + SCAN_SCOPES.join(", "));
    }
    const scope = (b.scope as ScanScope | undefined) ?? "unchecked";
    let sourceId: number | undefined;
    if (b.sourceId !== undefined && b.sourceId !== null) {
      sourceId = Number(b.sourceId);
      if (!Number.isInteger(sourceId)) throw new ApiError(400, "sourceId must be an integer");
      getSource(sourceId); // 404 when the source does not exist
    }
    // Sync first, then pick up the scope: a scan of 'missing' must see the
    // downloads that landed since the last sync, and a scan of 'corrupt'
    // must not chase files the *arr has already replaced. A scan running in
    // parallel would both race the sync and relink rows mid-flight, so the
    // batch gate is claimed before syncing; it also keeps a second batch
    // request from syncing (or deleting!) during this window.
    return runBatch("scan", async () => {
      if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
      const pending = { cancelled: false };
      pendingScan = pending;
      try {
        const synced = await syncSourcesForBatch(sourceId, "scan");
        // A Cancel click during the pre-scan sync must win over the scan that
        // was about to start.
        if (pending.cancelled) throw new ApiError(409, "Scan cancelled before it started");
        const runId = await scans.start(scope, sourceId);
        return { runId, scope, sourceId: sourceId ?? null, synced };
      } finally {
        if (pendingScan === pending) pendingScan = null;
      }
    });
  });

  app.post("/api/scan/cancel", async () => {
    // The scan may still be syncing the library (its run does not exist yet):
    // flag it so the route aborts instead of starting the scan anyway.
    if (pendingScan !== null) pendingScan.cancelled = true;
    scans.cancel();
    return { ok: true };
  });

  app.get("/api/scan/current", async () => ({ run: scans.currentRun(), active: scans.isActive() }));

  // ---- stats ----
  app.get("/api/stats", async () => {
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM media_files GROUP BY status").all() as {
      status: string;
      n: number;
    }[];
    const byStatus: Record<string, number> = {
      unchecked: 0,
      healthy: 0,
      suspect: 0,
      corrupt: 0,
      missing: 0,
      unreachable: 0,
      purged: 0
    };
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = Number(r.n);
      total += Number(r.n);
    }
    const lastScan =
      db
        .prepare(
          "SELECT r.id, r.scope, r.state, r.total, r.done, r.issues, r.started_at AS startedAt, r.finished_at AS finishedAt," +
            " r.source_id AS sourceId, s.name AS sourceName" +
            " FROM scan_runs r LEFT JOIN sources s ON s.id = r.source_id ORDER BY r.id DESC LIMIT 1"
        )
        .get() ?? null;
    // Per-source breakdown so the dashboard can scope buttons to one server.
    const sourceRows = db
      .prepare(
        "SELECT source_id AS sourceId, status, COUNT(*) AS n FROM media_files GROUP BY source_id, status"
      )
      .all() as { sourceId: number; status: string; n: number }[];
    const bySourceMap = new Map<
      number,
      { sourceId: number; total: number; byStatus: Record<string, number> }
    >();
    for (const r of sourceRows) {
      const group = bySourceMap.get(r.sourceId) ?? {
        sourceId: r.sourceId,
        total: 0,
        byStatus: {
          unchecked: 0,
          healthy: 0,
          suspect: 0,
          corrupt: 0,
          missing: 0,
          unreachable: 0,
          purged: 0
        }
      };
      group.byStatus[r.status] = Number(r.n);
      group.total += Number(r.n);
      bySourceMap.set(r.sourceId, group);
    }
    return { total, byStatus, bySource: [...bySourceMap.values()], lastScan, activeScan: scans.isActive() };
  });

  // ---- files ----
  const FILE_STATUSES = ["unchecked", "healthy", "suspect", "corrupt", "missing", "unreachable", "purged"];
  app.get("/api/files", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    // page/pageSize are bound straight into SQLite LIMIT/OFFSET, which rejects
    // a non-integer (Infinity, 1e300, 1.5) with a datatype error - a 500 for
    // what is merely malformed input. Normalize anything invalid to the
    // documented defaults instead.
    const page = positiveInt(q.page, 1);
    const pageSize = Math.min(200, positiveInt(q.pageSize, 50));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.status) {
      if (!FILE_STATUSES.includes(q.status))
        throw new ApiError(400, "status must be one of: " + FILE_STATUSES.join(", "));
      where.push("mf.status = ?");
      params.push(q.status);
    }
    if (q.sourceId) {
      const sid = Number(q.sourceId);
      if (!Number.isInteger(sid)) throw new ApiError(400, "sourceId must be an integer");
      where.push("mf.source_id = ?");
      params.push(sid);
    }
    if (q.q) {
      const needle = "%" + escapeLike(q.q) + "%";
      where.push(
        "(mf.title LIKE ? ESCAPE '!' OR mf.subtitle LIKE ? ESCAPE '!' OR mf.path LIKE ? ESCAPE '!')"
      );
      params.push(needle, needle, needle);
    }
    const whereSql = where.length > 0 ? " WHERE " + where.join(" AND ") : "";
    const sortMap: Record<string, string> = {
      title: "mf.title COLLATE NOCASE",
      status: "mf.status",
      checked: "mf.checked_at",
      size: "mf.size_bytes",
      id: "mf.id"
    };
    // Own-property lookup: a caller-supplied "sort=__proto__" (or any other
    // inherited name) must fall back to the default instead of concatenating
    // Object.prototype into the ORDER BY (an unhandled 500).
    const sortKey = q.sort ?? "id";
    const sortCol = Object.hasOwn(sortMap, sortKey) ? sortMap[sortKey] : sortMap.id;
    const dir = q.dir === "asc" ? "ASC" : "DESC";
    const total = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM media_files mf" + whereSql).get(...params) as { n: number }).n
    );
    const rows = db
      .prepare(
        "SELECT mf.id, mf.source_id AS sourceId, s.type AS sourceType, s.name AS sourceName, mf.kind, mf.title, mf.subtitle," +
          " mf.path, mf.size_bytes AS sizeBytes, mf.quality, mf.status, mf.duration_s AS durationS, mf.container," +
          " mf.video_codec AS videoCodec, mf.audio_codec AS audioCodec, mf.error_detail AS errorDetail, mf.checked_at AS checkedAt" +
          " FROM media_files mf JOIN sources s ON s.id = mf.source_id" +
          whereSql +
          " ORDER BY " +
          sortCol +
          " " +
          dir +
          " LIMIT ? OFFSET ?"
      )
      .all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows, total, page, pageSize };
  });

  app.get("/api/files/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid file id");
    const row = db
      .prepare(
        "SELECT mf.id, mf.source_id AS sourceId, s.type AS sourceType, s.name AS sourceName, mf.kind, mf.title, mf.subtitle," +
          " mf.path, mf.size_bytes AS sizeBytes, mf.quality, mf.status, mf.duration_s AS durationS, mf.container," +
          " mf.video_codec AS videoCodec, mf.audio_codec AS audioCodec, mf.error_detail AS errorDetail, mf.probe_json AS probeJson," +
          " mf.checked_at AS checkedAt FROM media_files mf JOIN sources s ON s.id = mf.source_id WHERE mf.id = ?"
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, "file not found");
    if (typeof row.probeJson === "string") {
      try {
        row.probe = JSON.parse(row.probeJson);
      } catch {
        row.probe = null;
      }
    } else {
      row.probe = null;
    }
    delete row.probeJson;
    return { file: row };
  });

  app.post("/api/files/:id/purge", async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid file id");
    return runBatch("delete", async () => {
      if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
      const row = getFileWithSource(id);
      if (!row) throw new ApiError(404, "file not found");
      if (!row.source_enabled)
        throw new ApiError(409, "this file's source is disabled - enable it in Settings to purge");
      // Sync the item first: a stale path must not be deleted, and the *arr
      // may have already removed the file itself.
      const synced = await syncSingleItem(row, "delete");
      if (!synced.found)
        throw new ApiError(404, "the *arr no longer has this item - it was removed during sync");
      // The batch gate is held, so no scan can start between the sync and the
      // delete: the file is never removed out from under a running scan.
      return purgeFiles(db, { fileId: id });
    });
  });

  app.post("/api/files/:id/research", async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid file id");
    return runBatch("re-search", async () => {
      if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
      const row = getFileWithSource(id);
      if (!row) throw new ApiError(404, "file not found");
      if (!row.source_enabled)
        throw new ApiError(409, "this file's source is disabled - enable it in Settings to search");
      // The *arr command needs its own numeric id: a junk external_id (a
      // malformed row) must be a 400, not a request for an undefined item.
      const externalId = Number(row.external_id);
      if (!allDigits(row.external_id) || !Number.isSafeInteger(externalId) || externalId <= 0)
        throw new ApiError(400, "this file has no valid *arr id - re-sync the library and try again");
      // Sync the item first: the *arr is the source of truth, and an item it no
      // longer tracks has no search to queue (the row is dropped, like re-check).
      const synced = await syncSingleItem(row, "search");
      if (!synced.found)
        throw new ApiError(404, "the *arr no longer has this item - it was removed during sync");
      // Same per-source command as the bulk re-search; one id needs no chunking.
      const errors: string[] = [];
      let searched = 0;
      try {
        await fetchArr(row.source_base_url, row.source_api_key, "/api/v3/command", {
          method: "POST",
          body:
            row.source_type === "radarr"
              ? { name: "MoviesSearch", movieIds: [externalId] }
              : { name: "EpisodesSearch", episodeIds: [externalId] }
        });
        searched = 1;
      } catch (err) {
        errors.push("search command failed: " + String((err as Error)?.message ?? err));
      }
      // name/type identify the *arr source, like the bulk research response.
      return { id: row.id, name: row.source_name, type: row.source_type, searched, errors };
    });
  });

  app.post("/api/files/:id/recheck", async (req) => {
    if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid file id");
    const row = getFileWithSource(id);
    if (!row) throw new ApiError(404, "file not found");
    // Sync the item before judging it: the row in our DB may predate the
    // download. Without this a 'missing' row could never leave 'missing' by
    // re-checking - the file only lands via a full library sync.
    const synced = await syncSingleItem(row, "re-check");
    if (!synced.found)
      throw new ApiError(404, "the *arr no longer has this item - it was removed during sync");
    // A scan can claim the manager while this item sync was in flight; don't
    // decode/persist a verdict over the scan's work.
    if (scans.isActive()) throw new ApiError(409, "a scan started while this item was syncing - try again");
    const file = db.prepare("SELECT id, path, status FROM media_files WHERE id = ?").get(id) as
      { id: number; path: string | null; status: string } | undefined;
    if (!file) throw new ApiError(404, "file not found");
    let outcome: CheckOutcome;
    if (file.path === null) {
      // Monitored with no file at the *arr (re-verified by the sync above):
      // nothing to decode, report missing without spinning up ffmpeg. A
      // purged row goes through the same persist guard as any verdict, so it
      // stays purged while it waits for its replacement.
      outcome = {
        status: "missing",
        detail: "no file at the *arr - monitored, not downloaded yet",
        probe: null
      };
    } else {
      const settings = getSettings(db);
      const binaries = resolveBinaries(settings);
      const problem = await binariesUsable(binaries);
      if (problem) throw new ApiError(400, problem);
      outcome = await checkMediaFile(file.path, { binaries, mappings: settings.pathMappings });
    }
    const verdict = persistCheckOutcome(db, file, outcome);
    if (verdict.wrote) return { id: file.id, status: verdict.status, detail: outcome.detail };
    if (verdict.reason === "purged-awaiting-replacement") {
      return {
        id: file.id,
        status: "purged",
        detail: "replacement not on disk yet - kept purged; sync to pick up the new download"
      };
    }
    // The row was relinked to a new download (or removed) while the check ran.
    const cur = db.prepare("SELECT id, status FROM media_files WHERE id = ?").get(file.id) as
      { id: number; status: string } | undefined;
    if (!cur) throw new ApiError(404, "file not found");
    return {
      id: cur.id,
      status: cur.status,
      detail: "the *arr replaced this file during the recheck - verdict discarded, run it again"
    };
  });

  // Range-aware streaming for the manual in-browser player.
  app.get("/api/files/:id/stream", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw new ApiError(400, "invalid file id");
    const row = db.prepare("SELECT path FROM media_files WHERE id = ?").get(id) as
      { path: string | null } | undefined;
    if (!row) throw new ApiError(404, "file not found");
    if (row.path === null) throw new ApiError(404, "no file at the *arr for this item");
    const localPath = resolveLocalPath(row.path, getSettings(db).pathMappings);
    let size: number;
    try {
      const st = await fs.promises.stat(localPath);
      if (!st.isFile()) throw new ApiError(404, "not a regular file");
      size = st.size;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(404, "file not accessible on disk: " + localPath);
    }
    const type = contentTypeFor(localPath);
    const range = parseRange(req.headers.range, size);
    if (range === "invalid") {
      return reply
        .code(416)
        .header("content-range", "bytes */" + size)
        .send();
    }
    if (range === "full") {
      reply
        .code(200)
        .header("content-type", type)
        .header("accept-ranges", "bytes")
        .header("content-length", size);
      return reply.send(fs.createReadStream(localPath));
    }
    reply
      .code(206)
      .header("content-type", type)
      .header("accept-ranges", "bytes")
      .header("content-range", "bytes " + range.start + "-" + range.end + "/" + size)
      .header("content-length", range.end - range.start + 1);
    return reply.send(fs.createReadStream(localPath, { start: range.start, end: range.end }));
  });
}
