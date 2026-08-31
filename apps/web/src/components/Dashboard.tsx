import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { formatWhen } from "../utils";
import { useStartScan } from "../useScan";
import { useScanState, useSettingsQuery, useSources, useStats } from "../hooks";
import { PURGEABLE_STATUSES, SCAN_SCOPES, STATUS_META, STATUS_ORDER } from "../status";
import type { PurgeStatus } from "../types";
import { Button } from "../ui/Button";
import { Select } from "../ui/controls";
import { useConfirm } from "../ui/ConfirmDialog";
import { ErrorBanner } from "../ui/ErrorBanner";
import { DropdownButton, type MenuItemSpec } from "../ui/Menu";
import { useToast } from "../ui/Toast";

/** Human words for run states; the DB stores raw tokens like "done". */
function runStateLabel(state: string): string {
  switch (state) {
    case "starting":
      return "Starting...";
    case "running":
      return "Running";
    case "cancelling":
      return "Cancelling...";
    case "done":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return state;
  }
}

const PURGE_DESCRIPTIONS: Record<PurgeStatus, string> = {
  corrupt: "Delete these files at the *arr and queue replacement searches.",
  suspect: "These may still play. Deleting removes them from disk.",
  unreachable: "The files exist but cannot be read. Deleting queues replacements.",
  all: "Deletes every tracked file in scope, healthy ones included."
};

export default function Dashboard({
  goLibrary,
  goSettings,
  scope,
  onScopeChange
}: {
  goLibrary: (status: string) => void;
  goSettings: () => void;
  /** "" = all servers; otherwise a source id. Owned by the router so it survives tab switches. */
  scope: string;
  onScopeChange: (v: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const stats = useStats();
  const scan = useScanState();
  const settings = useSettingsQuery();
  const sources = useSources();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["stats"] });
    queryClient.invalidateQueries({ queryKey: ["scan"] });
    queryClient.invalidateQueries({ queryKey: ["files"] });
  };

  const sync = useMutation({
    mutationFn: (sourceId: number | undefined) => api.sync(sourceId),
    onSuccess: (data) => {
      const parts = data.results.map((r) =>
        r.ok
          ? r.name +
            ": +" +
            (r.added ?? 0) +
            " new" +
            ((r.relinked ?? 0) > 0 ? ", " + r.relinked + " relinked to new downloads" : "") +
            ", " +
            (r.updated ?? 0) +
            " updated, -" +
            (r.removed ?? 0) +
            " removed"
          : r.name + ": FAILED - " + r.error
      );
      toast.success(parts.join("\n") || "Nothing to sync");
      invalidateAll();
    },
    onError: (err: Error) => toast.error("Sync failed: " + err.message)
  });

  const startScan = useStartScan((err) =>
    toast.error(
      err.message.toLowerCase().includes("cancel")
        ? "Scan cancelled before it started"
        : "Scan failed to start: " + err.message
    )
  );

  const purge = useMutation({
    mutationFn: (v: { status: PurgeStatus; sourceId?: number; confirm?: boolean }) =>
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
      // Every batch delete syncs the library first; say so, and what it brought in.
      const syncParts = (data.synced ?? []).map(
        (r) =>
          r.name +
          (r.ok
            ? " synced (" +
              "+" +
              (r.added ?? 0) +
              " new" +
              ((r.relinked ?? 0) > 0 ? ", " + r.relinked + " relinked" : "") +
              ")"
            : " sync FAILED")
      );
      const what = v.status === "all" ? "file(s)" : v.status + " file(s)";
      toast.success(
        "Deleted " +
          data.total +
          " " +
          what +
          " and queued searches for replacements." +
          (syncParts.length ? "\nLibrary synced first - " + syncParts.join(" | ") : "") +
          (parts.length ? "\n" + parts.join(" | ") : "")
      );
      invalidateAll();
    },
    onError: (err: Error) => toast.error("Delete failed: " + err.message)
  });

  const active = scan.data?.active ?? false;
  const run = scan.data?.run ?? null;
  const lastScan = stats.data?.lastScan ?? null;

  // Everything on this page acts on the same scope: the selected server.
  const scopeId = scope === "" ? undefined : Number(scope);
  const scopeSource = sources.data?.sources.find((s) => String(s.id) === scope) ?? null;
  const scopeStats =
    scopeId === undefined ? stats.data : stats.data?.bySource.find((s) => s.sourceId === scopeId);
  const byStatus = scopeStats?.byStatus ?? {};
  const scopeTotal = scopeStats?.total ?? 0;
  const hasSources = (sources.data?.sources.length ?? 0) > 0;
  const scopeLabel = scopeSource?.name ?? "all servers";

  const confirmScanEverything = async () => {
    const ok = await confirm({
      title: "Scan everything?",
      body:
        "Re-check every file in " +
        scopeLabel +
        ", including healthy ones?\n\nThis takes much longer than a scoped scan.",
      confirmLabel: "Scan everything"
    });
    if (ok) {
      startScan.mutate({ scope: "all", sourceId: scopeId, sourceName: scopeSource?.name ?? undefined });
    }
  };

  const scanItems: MenuItemSpec[] = [
    ...SCAN_SCOPES.map<MenuItemSpec>((s) => ({
      key: s,
      label: STATUS_META[s].label,
      hint: String(byStatus[s] ?? 0),
      description: STATUS_META[s].description,
      disabled: (byStatus[s] ?? 0) === 0,
      onSelect: () =>
        startScan.mutate({ scope: s, sourceId: scopeId, sourceName: scopeSource?.name ?? undefined })
    })),
    {
      key: "all",
      label: "Everything",
      hint: scopeTotal + " files",
      description: "Re-check every file in scope, healthy ones included.",
      onSelect: () => {
        void confirmScanEverything();
      }
    }
  ];

  const confirmPurge = async (status: PurgeStatus) => {
    const n = status === "all" ? scopeTotal : (byStatus[status] ?? 0);
    const body =
      status === "all"
        ? "Every tracked file in " +
          scopeLabel +
          " is removed from disk, healthy ones included, and replacement searches are queued.\n\nThis cannot be undone."
        : status === "suspect"
          ? "Suspect files may still play (recoverable errors were reported). The files are removed from disk and replacement searches are queued at the *arr.\n\nThis cannot be undone."
          : "The files are removed from disk and replacement searches are queued at the *arr.\n\nThis cannot be undone.";
    const ok = await confirm({
      title: "Delete " + n + " " + (status === "all" ? "" : status + " ") + "file(s) in " + scopeLabel + "?",
      body,
      confirmLabel: "Delete " + n + " file(s)",
      danger: true
    });
    if (ok) {
      purge.mutate({ status, sourceId: scopeId, confirm: status === "all" ? true : undefined });
    }
  };

  const purgeItems: MenuItemSpec[] = [
    ...PURGEABLE_STATUSES.map<MenuItemSpec>((s) => ({
      key: s,
      label: STATUS_META[s].label + " files",
      hint: String(byStatus[s] ?? 0),
      description: PURGE_DESCRIPTIONS[s],
      disabled: (byStatus[s] ?? 0) === 0,
      onSelect: () => {
        void confirmPurge(s);
      }
    })),
    {
      key: "all",
      label: "Everything",
      hint: scopeTotal + " files",
      description: PURGE_DESCRIPTIONS.all,
      danger: true,
      onSelect: () => {
        void confirmPurge("all");
      }
    }
  ];

  const busyTitle = active ? "A scan is running - wait for it to finish or cancel it" : undefined;

  return (
    <div className="space-y-6">
      {settings.isError && (
        <ErrorBanner>
          Could not load settings: {(settings.error as Error)?.message ?? "unknown error"} - scan buttons may
          be wrong until it loads.
        </ErrorBanner>
      )}
      {stats.isError && (
        <ErrorBanner>
          Could not load stats: {(stats.error as Error)?.message ?? "unknown error"} - the cards below are not
          live.
        </ErrorBanner>
      )}
      {sources.isError && (
        <ErrorBanner>
          Could not load sources: {(sources.error as Error)?.message ?? "unknown error"}
        </ErrorBanner>
      )}
      {!settings.isLoading && settings.data && !settings.data.ffmpegAvailable && (
        <ErrorBanner>
          ffmpeg is not available: {settings.data.ffmpegError} - scans will not run. Configure a path in
          Settings.
        </ErrorBanner>
      )}

      {sources.data && sources.data.sources.length === 0 && (
        <div className="border border-dashed border-neutral-300 p-6">
          <h2 className="text-sm font-semibold">Get started</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-neutral-600">
            <li>Add your Radarr or Sonarr instance (URL + API key) in Settings.</li>
            <li>Sync its library here - every monitored movie and episode gets a row.</li>
            <li>Run a scan to check that every file actually plays.</li>
          </ol>
          <Button variant="primary" className="mt-3" onClick={goSettings}>
            Add a source
          </Button>
        </div>
      )}

      <div className="grid grid-cols-4 border-y border-neutral-200 sm:grid-cols-7">
        {STATUS_ORDER.map((s) => {
          const meta = STATUS_META[s];
          return (
            <button
              key={s}
              onClick={() => goLibrary(s)}
              title={meta.description}
              className="px-3 py-4 text-left hover:bg-neutral-50"
            >
              <div className={"text-2xl " + meta.text}>{byStatus[s] ?? 0}</div>
              <div className="mt-1 text-xs text-neutral-500">{meta.label}</div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-500">
          Server
          <Select
            value={scope}
            onChange={(e) => onScopeChange(e.target.value)}
            title="Sync, scan and delete operate on the selected server"
            className="w-auto"
          >
            <option value="">All servers</option>
            {(sources.data?.sources ?? []).map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <Button
          onClick={() => sync.mutate(scopeId)}
          disabled={sync.isPending || active || !hasSources}
          title={busyTitle ?? (!hasSources ? "Add a source first" : undefined)}
        >
          {sync.isPending ? "Syncing..." : "Sync library"}
        </Button>
        <DropdownButton
          label={startScan.isPending ? "Starting..." : "Scan"}
          variant="primary"
          items={scanItems}
          disabled={active || startScan.isPending || !hasSources}
          title={busyTitle ?? "Decode-probe the selected library"}
        />
        <DropdownButton
          label={purge.isPending ? "Deleting..." : "Delete & re-search"}
          variant="danger"
          items={purgeItems}
          disabled={purge.isPending || active || scopeTotal === 0}
          title={
            busyTitle ??
            (scopeTotal === 0
              ? "Nothing tracked in this scope"
              : "Delete files at " + scopeLabel + " and queue searches for replacements")
          }
        />
      </div>

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
              {runStateLabel(run.state)}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            {[
              ["library", run.sourceName ?? "all"],
              [
                "scope",
                run.scope === "all"
                  ? "everything"
                  : (STATUS_META[run.scope as keyof typeof STATUS_META]?.label ?? run.scope)
              ],
              ["progress", run.done + " / " + run.total],
              ["issues", String(run.issues)],
              ["started", formatWhen(run.startedAt)],
              ["finished", formatWhen(run.finishedAt)]
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2">
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

      <details className="border-t border-neutral-200 pt-4 text-sm text-neutral-500">
        <summary className="cursor-pointer select-none font-medium text-neutral-700">How checks work</summary>
        <p className="mt-1">
          Every file is probed with ffprobe, then decoded with ffmpeg: one second at the start, one second
          from the middle (50% of duration), and one second from 99% of the way to the end. Files that fail to
          decode are marked corrupt; files with recoverable errors or no known duration are marked suspect.
        </p>
      </details>
    </div>
  );
}
