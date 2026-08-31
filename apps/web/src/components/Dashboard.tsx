import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { formatWhen } from "../utils";
import { useCancelScan, useScanPollingGate, useStartScan } from "../useScan";

const CARDS: { status: string; label: string; text: string }[] = [
  { status: "healthy", label: "Healthy", text: "text-emerald-600" },
  { status: "corrupt", label: "Corrupt", text: "text-red-600" },
  { status: "suspect", label: "Suspect", text: "text-amber-600" },
  { status: "missing", label: "Missing", text: "text-sky-600" },
  { status: "unreachable", label: "Unreachable", text: "text-violet-600" },
  { status: "purged", label: "Purged", text: "text-fuchsia-600" },
  { status: "unchecked", label: "Unchecked", text: "text-neutral-400" }
];

const BTN =
  "border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-40";
const BTN_PRIMARY = "bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40";

export default function Dashboard({
  onGoLibrary
}: {
  onGoLibrary: (status: string | null, sourceId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: (q) => (q.state.data?.activeScan ? 1500 : 5000)
  });
  const scanPollPaused = useScanPollingGate();
  const scan = useQuery({
    queryKey: ["scan"],
    queryFn: api.currentScan,
    refetchInterval: scanPollPaused ? false : (q) => (q.state.data?.active ? 1500 : 5000)
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources });
  // Which library the scan buttons target; empty string means every library.
  const [library, setLibrary] = useState<string>("");
  const [scanOpen, setScanOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);

  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = (msg: string) => {
    setMessage(msg);
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setMessage(null), 6000);
  };

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["stats"] });
    queryClient.invalidateQueries({ queryKey: ["scan"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
  };

  const sync = useMutation({
    mutationFn: (sourceId?: number) => api.sync(sourceId),
    onSuccess: (data) => {
      const parts = data.results.map((r) =>
        r.ok
          ? r.name +
            ": +" +
            (r.added ?? 0) +
            " new, " +
            (r.updated ?? 0) +
            " updated, -" +
            (r.removed ?? 0) +
            " removed"
          : r.name + ": FAILED - " + r.error
      );
      notify(parts.join(" | ") || "nothing to sync");
      invalidateAll();
    },
    onError: (err: Error) => notify("Sync failed: " + err.message)
  });

  const startScan = useStartScan((err) =>
    notify(
      err.message.toLowerCase().includes("cancel")
        ? "Scan cancelled before it started"
        : "Scan failed to start: " + err.message
    )
  );

  const cancelScan = useCancelScan();

  const purge = useMutation({
    mutationFn: (v: { status: "corrupt" | "suspect" | "all"; sourceId?: number; confirm?: boolean }) =>
      api.purge(v.status, v.sourceId, v.confirm),
    onSuccess: (data, v) => {
      const parts = data.results.map(
        (r) =>
          r.name +
          ": " +
          r.deleted +
          " deleted, " +
          r.searched +
          " searches queued" +
          (r.skipped ? ", " + r.skipped + " already gone" : "") +
          (r.errors.length ? ", " + r.errors.length + " failed" : "")
      );
      const what = v.status === "all" ? "file(s)" : v.status + " file(s)";
      notify(
        "Deleted " +
          data.total +
          " " +
          what +
          " and queued searches for replacements. " +
          (parts.join(" | ") || "nothing to do") +
          " Re-sync and re-scan later to check the new downloads."
      );
      invalidateAll();
    },
    onError: (err: Error) => notify("Purge failed: " + err.message)
  });

  const active = scan.data?.active ?? false;
  const run = scan.data?.run ?? null;
  const lastScan = stats.data?.lastScan ?? null;
  const libraryId = library === "" ? undefined : Number(library);
  const libraryName = sources.data?.sources.find((s) => String(s.id) === library)?.name ?? null;
  // Stats scoped to the picker: everything when "all", else just that server.
  const scopeStats =
    libraryId === undefined ? stats.data : stats.data?.bySource.find((s) => s.sourceId === libraryId);
  const scopeTotal = scopeStats?.total ?? 0;
  const scopeByStatus = scopeStats?.byStatus ?? {};

  return (
    <div className="space-y-6">
      {settings.isError && (
        <div className="border border-red-300 px-4 py-3 text-sm text-red-700">
          Could not load settings: {(settings.error as Error)?.message ?? "unknown error"} - scan buttons may
          be wrong until it loads.
        </div>
      )}
      {stats.isError && (
        <div className="border border-red-300 px-4 py-3 text-sm text-red-700">
          Could not load stats: {(stats.error as Error)?.message ?? "unknown error"} - the cards below are not
          live.
        </div>
      )}
      {sources.isError && (
        <div className="border border-red-300 px-4 py-3 text-sm text-red-700">
          Could not load sources: {(sources.error as Error)?.message ?? "unknown error"}
        </div>
      )}
      {!settings.isLoading && settings.data && !settings.data.ffmpegAvailable && (
        <div className="border border-red-300 px-4 py-3 text-sm text-red-700">
          ffmpeg is not available: {settings.data.ffmpegError} - scans will not run. Configure a path in
          Settings.
        </div>
      )}

      <div className="grid grid-cols-4 border-y border-neutral-200 sm:grid-cols-7">
        {CARDS.map((c) => (
          <button
            key={c.status}
            onClick={() => onGoLibrary(c.status, library)}
            className="px-3 py-4 text-left hover:bg-neutral-50"
          >
            <div className={"text-2xl " + c.text}>{scopeByStatus[c.status] ?? 0}</div>
            <div className="mt-1 text-xs text-neutral-500">{c.label}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={library}
          onChange={(e) => setLibrary(e.target.value)}
          className={BTN}
          title="All buttons operate on the selected server"
        >
          <option value="">All servers</option>
          {(sources.data?.sources ?? []).map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
            </option>
          ))}
        </select>
        <button onClick={() => sync.mutate(libraryId)} disabled={sync.isPending || active} className={BTN}>
          {sync.isPending ? "Syncing..." : "Sync library"}
        </button>
        <div className="relative">
          <button
            onClick={() => setScanOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={scanOpen}
            disabled={active || startScan.isPending}
            className={BTN_PRIMARY}
            title="Decode-probe the selected library"
          >
            <span className="inline-flex items-center gap-1.5">
              {startScan.isPending ? "Starting..." : "Scan"}
              <span
                aria-hidden="true"
                className={
                  "inline-block text-[10px] leading-none transition-transform " +
                  (scanOpen ? "rotate-180" : "")
                }
              >
                &#9662;
              </span>
            </span>
          </button>
          {scanOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setScanOpen(false)} />
              <div className="absolute left-0 top-full z-20 mt-1 w-64 border border-neutral-200 bg-white py-1 shadow-lg">
                {(
                  [
                    ["unchecked", "Unscanned", scopeByStatus.unchecked ?? 0],
                    ["corrupt", "Corrupt", scopeByStatus.corrupt ?? 0],
                    ["suspect", "Suspect", scopeByStatus.suspect ?? 0],
                    ["missing", "Missing", scopeByStatus.missing ?? 0],
                    ["unreachable", "Unreachable", scopeByStatus.unreachable ?? 0],
                    ["purged", "Purged", scopeByStatus.purged ?? 0]
                  ] as const
                )
                  .filter(([, , n]) => n > 0)
                  .map(([scope, label, n]) => (
                    <button
                      key={scope}
                      onClick={() => {
                        setScanOpen(false);
                        startScan.mutate({
                          scope,
                          sourceId: libraryId,
                          sourceName: libraryName ?? undefined
                        });
                      }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100"
                    >
                      {label} <span className="text-neutral-400">({n})</span>
                    </button>
                  ))}
                <button
                  onClick={() => {
                    setScanOpen(false);
                    const where = libraryName ? " in " + libraryName : "";
                    if (
                      window.confirm(
                        "Re-check every file" + where + ", including healthy ones? This takes much longer."
                      )
                    ) {
                      startScan.mutate({
                        scope: "all",
                        sourceId: libraryId,
                        sourceName: libraryName ?? undefined
                      });
                    }
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100"
                >
                  Everything <span className="text-neutral-400">({scopeTotal} files)</span>
                </button>
              </div>
            </>
          )}
        </div>
        {scopeTotal > 0 && (
          <div className="relative">
            <button
              onClick={() => setPurgeOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={purgeOpen}
              disabled={purge.isPending || active}
              className={BTN + " hover:border-red-600 hover:text-red-600"}
              title={
                libraryName
                  ? "Delete files at " + libraryName + " and queue searches for replacements"
                  : "Delete files at their *arr source and queue searches for replacements"
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {purge.isPending ? "Purging..." : "Delete & re-search"}
                <span
                  aria-hidden="true"
                  className={
                    "inline-block text-[10px] leading-none transition-transform " +
                    (purgeOpen ? "rotate-180" : "")
                  }
                >
                  &#9662;
                </span>
              </span>
            </button>
            {purgeOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPurgeOpen(false)} />
                <div className="absolute left-0 top-full z-20 mt-1 w-64 border border-neutral-200 bg-white py-1 shadow-lg">
                  {(scopeByStatus.corrupt ?? 0) > 0 && (
                    <button
                      onClick={() => {
                        setPurgeOpen(false);
                        const n = scopeByStatus.corrupt ?? 0;
                        if (
                          window.confirm(
                            "Delete " +
                              n +
                              " corrupt file(s) from " +
                              (libraryName ?? "Radarr/Sonarr") +
                              " and search for replacements?\n\nThe files are removed from disk. This cannot be undone."
                          )
                        ) {
                          purge.mutate({ status: "corrupt", sourceId: libraryId });
                        }
                      }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100"
                    >
                      Corrupt files <span className="text-neutral-400">({scopeByStatus.corrupt ?? 0})</span>
                    </button>
                  )}
                  {(scopeByStatus.suspect ?? 0) > 0 && (
                    <button
                      onClick={() => {
                        setPurgeOpen(false);
                        const n = scopeByStatus.suspect ?? 0;
                        if (
                          window.confirm(
                            "Delete " +
                              n +
                              " suspect file(s) from " +
                              (libraryName ?? "Radarr/Sonarr") +
                              " and search for replacements?\n\nSuspect files may still play (recoverable errors were reported). The files are removed from disk. This cannot be undone."
                          )
                        ) {
                          purge.mutate({ status: "suspect", sourceId: libraryId });
                        }
                      }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100"
                    >
                      Suspect files <span className="text-neutral-400">({scopeByStatus.suspect ?? 0})</span>
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setPurgeOpen(false);
                      const n = scopeTotal;
                      if (
                        window.confirm(
                          "Delete ALL " +
                            n +
                            " tracked file(s)" +
                            (libraryName ? " on " + libraryName : " across all servers") +
                            ", including healthy ones, and search for replacements?\n\nEvery file is removed from disk. This cannot be undone."
                        )
                      ) {
                        purge.mutate({ status: "all", sourceId: libraryId, confirm: true });
                      }
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-neutral-100"
                  >
                    Everything <span className="text-neutral-400">({scopeTotal} files)</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {active && (
          <button
            onClick={() => cancelScan.mutate()}
            disabled={cancelScan.isPending || run?.state === "cancelling"}
            className="border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:border-red-600 hover:text-red-600 disabled:opacity-40"
          >
            {cancelScan.isPending || run?.state === "cancelling" ? "Cancelling..." : "Cancel scan"}
          </button>
        )}
      </div>

      {message && (
        <div className="border border-neutral-200 px-4 py-3 text-sm text-neutral-600">{message}</div>
      )}

      {run && run.id > 0 && (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">Scan run #{run.id}</span>
            <span
              className={
                "text-xs " +
                (run.state === "running"
                  ? "text-emerald-600"
                  : run.state === "done"
                    ? "text-neutral-500"
                    : "text-amber-600")
              }
            >
              {run.state}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            {[
              ["library", run.sourceName ?? "all"],
              ["scope", run.scope],
              ["progress", run.done + " / " + run.total],
              ["issues", String(run.issues)],
              ["started", formatWhen(run.startedAt)],
              ["finished", formatWhen(run.finishedAt)]
            ].map(([k, v]) => (
              <div key={k as string} className="flex gap-2">
                <dt className="text-neutral-400">{k}:</dt>
                <dd className="text-neutral-700">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {!run && lastScan && (
        <div className="text-xs text-neutral-400">
          last scan: {formatWhen(lastScan.finishedAt ?? lastScan.startedAt)}
        </div>
      )}

      <div className="border-t border-neutral-200 pt-4 text-sm text-neutral-500">
        <p className="font-medium text-neutral-700">How checks work</p>
        <p className="mt-1">
          Every file is probed with ffprobe, then decoded with ffmpeg: one second at the start, one second
          from the middle (50% of duration), and one second from 99% of the way to the end. Files that fail to
          decode are marked corrupt; files with recoverable errors or no known duration are marked suspect.
        </p>
      </div>
    </div>
  );
}
