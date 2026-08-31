import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { formatWhen } from "../utils";
import { useCancelScan, useStartScan } from "../useScan";

const CARDS: { status: string; label: string; text: string }[] = [
  { status: "healthy", label: "Healthy", text: "text-emerald-600" },
  { status: "corrupt", label: "Corrupt", text: "text-red-600" },
  { status: "suspect", label: "Suspect", text: "text-amber-600" },
  { status: "missing", label: "Missing", text: "text-sky-600" },
  { status: "unreachable", label: "Unreachable", text: "text-violet-600" },
  { status: "unchecked", label: "Unchecked", text: "text-neutral-400" }
];

const BTN = "border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-40";
const BTN_PRIMARY = "bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40";

type StartScan = ReturnType<typeof useStartScan>;

/** Show "Starting..." only on the button that was actually clicked. */
function scanButtonLabel(m: StartScan, scope: "unchecked" | "all", idle: string): string {
  return m.isPending && m.variables?.scope === scope ? "Starting..." : idle;
}

export default function Dashboard({ onGoLibrary }: { onGoLibrary: (status: string | null) => void }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats, refetchInterval: (q) => (q.state.data?.activeScan ? 1500 : 5000) });
  const scan = useQuery({ queryKey: ["scan"], queryFn: api.currentScan, refetchInterval: (q) => (q.state.data?.active ? 1500 : 5000) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources });
  // Which library the scan buttons target; empty string means every library.
  const [library, setLibrary] = useState<string>("");

  const notify = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 6000);
  };

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["stats"] });
    queryClient.invalidateQueries({ queryKey: ["scan"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
  };

  const sync = useMutation({
    mutationFn: () => api.sync(),
    onSuccess: (data) => {
      const parts = data.results.map((r) => (r.ok ? r.name + ": +" + (r.added ?? 0) + " new, " + (r.updated ?? 0) + " updated, -" + (r.removed ?? 0) + " removed" : r.name + ": FAILED - " + r.error));
      notify(parts.join(" | ") || "nothing to sync");
      invalidateAll();
    },
    onError: (err: Error) => notify("Sync failed: " + err.message)
  });

  const startScan = useStartScan((err) =>
    notify(err.message.toLowerCase().includes("cancel") ? "Scan cancelled before it started" : "Scan failed to start: " + err.message)
  );

  const cancelScan = useCancelScan();

  const purge = useMutation({
    mutationFn: (status: "corrupt" | "suspect" | "all") => api.purge(status),
    onSuccess: (data, status) => {
      const parts = data.results.map((r) =>
        r.name + ": " + r.deleted + " deleted, " + r.searched + " searches queued" +
        (r.skipped ? ", " + r.skipped + " already gone" : "") +
        (r.errors.length ? ", " + r.errors.length + " failed" : "")
      );
      const what = status === "all" ? "file(s)" : status + " file(s)";
      notify(
        "Deleted " + data.total + " " + what + " and queued searches for replacements. " +
        (parts.join(" | ") || "nothing to do") +
        " Re-sync and re-scan later to check the new downloads."
      );
      invalidateAll();
    },
    onError: (err: Error) => notify("Purge failed: " + err.message)
  });

  const active = scan.data?.active ?? false;
  const run = scan.data?.run ?? null;
  const byStatus = stats.data?.byStatus ?? {};
  const lastScan = stats.data?.lastScan ?? null;
  const libraryId = library === "" ? undefined : Number(library);
  const libraryName = sources.data?.sources.find((s) => String(s.id) === library)?.name ?? null;

  return (
    <div className="space-y-6">
      {!settings.isLoading && settings.data && !settings.data.ffmpegAvailable && (
        <div className="border border-red-300 px-4 py-3 text-sm text-red-700">
          ffmpeg is not available: {settings.data.ffmpegError} - scans will not run. Configure a path in Settings.
        </div>
      )}

      <div className="grid grid-cols-3 border-y border-neutral-200 sm:grid-cols-6">
        {CARDS.map((c) => (
          <button
            key={c.status}
            onClick={() => onGoLibrary(c.status)}
            className="px-3 py-4 text-left hover:bg-neutral-50"
          >
            <div className={"text-2xl " + c.text}>{byStatus[c.status] ?? 0}</div>
            <div className="mt-1 text-xs text-neutral-500">{c.label}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={library}
          onChange={(e) => setLibrary(e.target.value)}
          className={BTN}
          title="Limit scans to one library"
        >
          <option value="">All libraries</option>
          {(sources.data?.sources ?? []).map((s) => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
        <button onClick={() => sync.mutate()} disabled={sync.isPending || active} className={BTN}>
          {sync.isPending ? "Syncing..." : "Sync libraries"}
        </button>
        <button
          onClick={() => startScan.mutate({ scope: "unchecked", sourceId: libraryId, sourceName: libraryName ?? undefined })}
          disabled={active || startScan.isPending}
          className={BTN_PRIMARY}
        >
          {scanButtonLabel(startScan, "unchecked", "Scan unchecked")}
        </button>
        <button
          onClick={() => {
            const where = libraryName ? " in " + libraryName : "";
            if (window.confirm("Re-check every file" + where + ", including healthy ones? This takes much longer.")) {
              startScan.mutate({ scope: "all", sourceId: libraryId, sourceName: libraryName ?? undefined });
            }
          }}
          disabled={active || startScan.isPending}
          className={BTN}
        >
          {scanButtonLabel(startScan, "all", "Re-scan everything")}
        </button>
        {(byStatus.corrupt ?? 0) > 0 && (
          <button
            onClick={() => {
              const n = byStatus.corrupt ?? 0;
              if (
                window.confirm(
                  "Delete " + n + " corrupt file(s) from Radarr/Sonarr and search for replacements?\n\nThe files are removed from disk. This cannot be undone."
                )
              ) {
                purge.mutate("corrupt");
              }
            }}
            disabled={purge.isPending || active}
            className={BTN + " hover:border-red-600 hover:text-red-600"}
            title="Deletes the corrupt files at the *arr source and queues searches for replacements"
          >
            {purge.isPending && purge.variables === "corrupt" ? "Purging..." : "Delete & re-search corrupt (" + (byStatus.corrupt ?? 0) + ")"}
          </button>
        )}
        {(byStatus.suspect ?? 0) > 0 && (
          <button
            onClick={() => {
              const n = byStatus.suspect ?? 0;
              if (
                window.confirm(
                  "Delete " + n + " suspect file(s) from Radarr/Sonarr and search for replacements?\n\nSuspect files may still play (recoverable errors were reported). The files are removed from disk. This cannot be undone."
                )
              ) {
                purge.mutate("suspect");
              }
            }}
            disabled={purge.isPending || active}
            className={BTN + " hover:border-red-600 hover:text-red-600"}
            title="Deletes the suspect files at the *arr source and queues searches for replacements"
          >
            {purge.isPending && purge.variables === "suspect" ? "Purging..." : "Delete & re-search suspect (" + (byStatus.suspect ?? 0) + ")"}
          </button>
        )}
        {(stats.data?.total ?? 0) > 0 && (
          <button
            onClick={() => {
              const n = stats.data?.total ?? 0;
              if (
                window.confirm(
                  "Delete ALL " + n + " tracked file(s), including healthy ones, from Radarr/Sonarr and search for replacements?\n\nEvery file is removed from disk. This cannot be undone."
                )
              ) {
                purge.mutate("all");
              }
            }}
            disabled={purge.isPending || active}
            className={BTN + " hover:border-red-600 hover:text-red-600"}
            title="Deletes every tracked file at its *arr source and queues searches for replacements"
          >
            {purge.isPending && purge.variables === "all" ? "Purging..." : "Delete & re-search everything"}
          </button>
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

      {message && <div className="border border-neutral-200 px-4 py-3 text-sm text-neutral-600">{message}</div>}

      {run && run.id > 0 && (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">Scan run #{run.id}</span>
            <span className={"text-xs " + (run.state === "running" ? "text-emerald-600" : run.state === "done" ? "text-neutral-500" : "text-amber-600")}>
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
        <div className="text-xs text-neutral-400">last scan: {formatWhen(lastScan.finishedAt ?? lastScan.startedAt)}</div>
      )}

      <div className="border-t border-neutral-200 pt-4 text-sm text-neutral-500">
        <p className="font-medium text-neutral-700">How checks work</p>
        <p className="mt-1">
          Every file is probed with ffprobe, then decoded with ffmpeg: the first 10 seconds, and 10 seconds from the
          middle (50% of duration). Files that fail to decode are marked corrupt;
          files with recoverable errors or no known duration are marked suspect.
        </p>
      </div>
    </div>
  );
}
