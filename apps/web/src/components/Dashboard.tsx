import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { formatRelative } from "../utils";
import { useStartScan } from "../useScan";
import { useScanState, useSettingsQuery, useSources, useStats } from "../hooks";
import { SCAN_SCOPES, STATUS_META } from "../status";
import type { PurgeStatus, ResearchStatus } from "../types";
import { Button } from "../ui/Button";
import { Select } from "../ui/controls";
import { useConfirm } from "../ui/ConfirmDialog";
import { ErrorBanner } from "../ui/ErrorBanner";
import { DropdownButton, type MenuItemSpec } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import { MoreIcon } from "../ui/icons";

/** Statuses with a file on disk that can be deleted at the *arr. */
const ATTENTION_STATUSES: Exclude<PurgeStatus, "all">[] = ["corrupt", "suspect", "unreachable"];
/** Statuses whose file is not on disk: no action left but another search. */
const WAITING_STATUSES: ResearchStatus[] = ["missing", "purged"];

const WAITING_DESCRIPTIONS: Record<string, string> = {
  missing: "Monitored at the *arr, but no file has been downloaded yet.",
  purged: "Deleted via Delete & re-search and waiting for the replacement download."
};

const PURGE_DESCRIPTIONS: Record<PurgeStatus, string> = {
  corrupt: "Delete these files at the *arr and queue replacement searches.",
  suspect: "These may still play. Deleting removes them from disk.",
  unreachable: "The files exist but cannot be read. Deleting queues replacements.",
  all: "Deletes every tracked file in scope, healthy ones included."
};

function plural(n: number, word: string): string {
  return n + " " + word + (n === 1 ? "" : "s");
}

function syncLine(
  synced: { name: string; ok: boolean; added?: number; relinked?: number }[] | undefined
): string {
  // Every batch action syncs first; only say so when the sync changed something
  // (or failed), otherwise a clean success toast would be buried in noise.
  const rows = (synced ?? [])
    .filter((r) => !r.ok || (r.added ?? 0) > 0 || (r.relinked ?? 0) > 0)
    .map(
      (r) =>
        r.name +
        (r.ok
          ? " synced (+" +
            (r.added ?? 0) +
            " new" +
            ((r.relinked ?? 0) > 0 ? ", " + r.relinked + " relinked" : "") +
            ")"
          : " sync failed")
    );
  return rows.length > 0 ? "\nLibrary synced first: " + rows.join(" · ") : "";
}

export default function Dashboard({
  goLibrary,
  goSettings,
  scope,
  onScopeChange
}: {
  goLibrary: (status: string) => void;
  goSettings: () => void;
  /** "" = all libraries; otherwise a source id. Owned by the router so it survives tab switches. */
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
          : r.name + ": failed - " + r.error
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
      const what = v.status === "all" ? "file" : v.status + " file";
      const perSource = data.results.map(
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
      toast.success(
        "Deleted " +
          plural(data.total, what) +
          " and queued replacement searches." +
          syncLine(data.synced) +
          (perSource.length > 0 ? "\n" + perSource.join("\n") : "")
      );
      invalidateAll();
    },
    onError: (err: Error) => toast.error("Delete failed: " + err.message)
  });

  const research = useMutation({
    mutationFn: (v: { status: ResearchStatus; sourceId?: number }) =>
      api.researchMissing(v.sourceId, v.status),
    onSuccess: (data, v) => {
      const parts = data.results.map(
        (r) =>
          r.name +
          ": " +
          r.searched +
          " search" +
          (r.searched === 1 ? "" : "es") +
          " queued" +
          (r.skipped ? ", " + r.skipped + " skipped" : "") +
          (r.errors.length ? ", " + r.errors.length + " failed" : "")
      );
      toast.success(
        "Queued searches for " +
          plural(data.total, v.status === "missing" ? "missing item" : "purged item") +
          "." +
          syncLine(data.synced) +
          (parts.length > 0 ? "\n" + parts.join("\n") : "")
      );
      invalidateAll();
    },
    onError: (err: Error) => toast.error("Re-search failed: " + err.message)
  });

  const active = scan.data?.active ?? false;
  const lastScan = stats.data?.lastScan ?? null;

  // Everything on this page acts on the same scope: the selected library.
  const scopeId = scope === "" ? undefined : Number(scope);
  const scopeSource = sources.data?.sources.find((s) => String(s.id) === scope) ?? null;
  const scopeStats =
    scopeId === undefined ? stats.data : stats.data?.bySource.find((s) => s.sourceId === scopeId);
  const byStatus: Record<string, number> = scopeStats?.byStatus ?? {};
  const scopeTotal = scopeStats?.total ?? 0;
  const hasSources = (sources.data?.sources.length ?? 0) > 0;
  const scopeLabel = scopeSource?.name ?? "all libraries";
  const checked = Math.max(0, scopeTotal - (byStatus.unchecked ?? 0));

  const busyTitle = active ? "A scan is running - wait for it to finish or cancel it" : undefined;

  const subtitle = [
    scopeSource ? scopeSource.name : "All libraries",
    checked + " of " + scopeTotal + " checked",
    lastScan ? "last scan " + formatRelative(lastScan.finishedAt ?? lastScan.startedAt) : "no scan yet"
  ].join(" · ");

  const confirmScanEverything = async () => {
    const ok = await confirm({
      title: "Scan everything?",
      body:
        "Re-check all " +
        plural(scopeTotal, "file") +
        " in " +
        scopeLabel +
        ", including healthy ones.\n\nThis takes much longer than a scoped scan.",
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
      disabled: scopeTotal === 0,
      onSelect: () => {
        void confirmScanEverything();
      }
    }
  ];

  const confirmPurge = async (status: PurgeStatus) => {
    const n = status === "all" ? scopeTotal : (byStatus[status] ?? 0);
    if (n === 0) return;
    const what = status === "all" ? "file" : status + " file";
    const ok = await confirm({
      title: "Delete " + plural(n, what) + " in " + scopeLabel + "?",
      body: PURGE_DESCRIPTIONS[status] + "\n\nThis cannot be undone.",
      confirmLabel: "Delete " + plural(n, what),
      danger: true
    });
    if (ok) {
      purge.mutate({ status, sourceId: scopeId, confirm: status === "all" ? true : undefined });
    }
  };

  const moreItems: MenuItemSpec[] = [
    {
      key: "all",
      label: "Delete every file in scope…",
      description:
        "Removes " +
        plural(scopeTotal, "file") +
        " from disk in " +
        scopeLabel +
        ", healthy ones included, and queues replacements.",
      danger: true,
      disabled: scopeTotal === 0,
      onSelect: () => {
        void confirmPurge("all");
      }
    }
  ];

  return (
    <div className="space-y-10">
      {settings.isError && (
        <ErrorBanner>
          Could not load settings: {(settings.error as Error)?.message ?? "unknown error"} - scan options may
          be wrong until it loads.
        </ErrorBanner>
      )}
      {stats.isError && (
        <ErrorBanner>
          Could not load stats: {(stats.error as Error)?.message ?? "unknown error"} - the counts below are
          not live.
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

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Library health</h1>
          <p className="mt-1 text-sm text-neutral-600">{subtitle}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          Library
          <Select
            value={scope}
            onChange={(e) => onScopeChange(e.target.value)}
            title="Scan, delete and search act on the selected library"
            className="w-auto"
          >
            <option value="">All libraries</option>
            {(sources.data?.sources ?? []).map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {sources.data && sources.data.sources.length === 0 ? (
        <section aria-labelledby="get-started-heading" className="max-w-2xl border border-neutral-200 p-6">
          <h2 id="get-started-heading" className="text-base font-semibold text-neutral-900">
            Get started
          </h2>
          <ol className="mt-3 space-y-2 text-sm text-neutral-600">
            <li className="flex gap-3">
              <span aria-hidden="true" className="tabular-nums text-neutral-400">
                1.
              </span>
              <span>Add your Radarr or Sonarr instance (URL and API key) in Settings.</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="tabular-nums text-neutral-400">
                2.
              </span>
              <span>Sync its library: every monitored movie and episode gets a row.</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="tabular-nums text-neutral-400">
                3.
              </span>
              <span>Run a scan to check that every file actually plays.</span>
            </li>
          </ol>
          <Button variant="primary" className="mt-4" onClick={goSettings}>
            Add a source
          </Button>
        </section>
      ) : (
        <>
          <section aria-labelledby="scan-heading" className="border-t border-neutral-200 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-xl">
                <h2 id="scan-heading" className="text-sm font-semibold text-neutral-900">
                  Scan
                </h2>
                <p className="mt-1 text-sm text-neutral-600">
                  Decode each file at the start, middle, and end to find the ones that will not play. Scoped
                  scans re-check one status at a time.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <DropdownButton
                  label={startScan.isPending ? "Starting…" : "Scan library"}
                  variant="primary"
                  items={scanItems}
                  disabled={active || startScan.isPending || !hasSources}
                  title={busyTitle ?? "Decode-probe the selected library"}
                  ariaLabel="Scan library"
                />
                <Button
                  onClick={() => sync.mutate(scopeId)}
                  disabled={sync.isPending || active || !hasSources}
                  title={busyTitle ?? (!hasSources ? "Add a source first" : undefined)}
                >
                  {sync.isPending ? "Syncing…" : "Sync library"}
                </Button>
              </div>
            </div>
            {active && (
              <p className="mt-3 text-xs text-neutral-500">
                A scan is running - progress is shown at the top of the page.
              </p>
            )}
          </section>

          <section aria-labelledby="attention-heading" className="border-t border-neutral-200 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="max-w-xl">
                <h2 id="attention-heading" className="text-sm font-semibold text-neutral-900">
                  Needs attention
                </h2>
                <p className="mt-1 text-sm text-neutral-600">
                  Files that failed a check or cannot be read. Delete &amp; re-search removes the file at the
                  *arr and queues a replacement.
                </p>
              </div>
              <DropdownButton
                label={<MoreIcon />}
                ariaLabel="More actions for problem files"
                variant="ghost"
                size="sm"
                caret={false}
                align="right"
                items={moreItems}
              />
            </div>
            <ul className="mt-3 divide-y divide-neutral-100 border-y border-neutral-200">
              {ATTENTION_STATUSES.map((status) => {
                const meta = STATUS_META[status];
                const count = byStatus[status] ?? 0;
                const deleting = purge.isPending && purge.variables?.status === status;
                return (
                  <li key={status} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <div className="flex w-44 shrink-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={"inline-block h-1.5 w-1.5 rounded-full " + meta.dot}
                      />
                      <span
                        className={
                          "flex-1 text-sm font-medium " +
                          (count > 0 ? "text-neutral-900" : "text-neutral-500")
                        }
                      >
                        {meta.label}
                      </span>
                      <span className="text-xs tabular-nums text-neutral-500">{count}</span>
                    </div>
                    <p className="min-w-0 flex-1 text-sm text-neutral-600">{meta.description}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={count === 0}
                        onClick={() => goLibrary(status)}
                      >
                        Review
                      </Button>
                      <Button
                        size="sm"
                        variant="dangerOutline"
                        disabled={count === 0 || active || purge.isPending}
                        title={busyTitle}
                        onClick={() => {
                          void confirmPurge(status);
                        }}
                      >
                        {deleting ? "Deleting…" : "Delete & re-search"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="waiting-heading" className="border-t border-neutral-200 pt-6">
            <div className="max-w-xl">
              <h2 id="waiting-heading" className="text-sm font-semibold text-neutral-900">
                Waiting on the *arr
              </h2>
              <p className="mt-1 text-sm text-neutral-600">
                Rows with no file on disk. Search now asks the *arr to look again; a sync picks the download
                up when it lands.
              </p>
            </div>
            <ul className="mt-3 divide-y divide-neutral-100 border-y border-neutral-200">
              {WAITING_STATUSES.map((status) => {
                const meta = STATUS_META[status];
                const count = byStatus[status] ?? 0;
                const searching = research.isPending && research.variables?.status === status;
                return (
                  <li key={status} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <div className="flex w-44 shrink-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={"inline-block h-1.5 w-1.5 rounded-full " + meta.dot}
                      />
                      <span
                        className={
                          "flex-1 text-sm font-medium " +
                          (count > 0 ? "text-neutral-900" : "text-neutral-500")
                        }
                      >
                        {meta.label}
                      </span>
                      <span className="text-xs tabular-nums text-neutral-500">{count}</span>
                    </div>
                    <p className="min-w-0 flex-1 text-sm text-neutral-600">{WAITING_DESCRIPTIONS[status]}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={count === 0}
                        onClick={() => goLibrary(status)}
                      >
                        Review
                      </Button>
                      <Button
                        size="sm"
                        disabled={count === 0 || active || research.isPending || !hasSources}
                        title={
                          busyTitle ??
                          (count === 0
                            ? "Nothing " + status + " in this library"
                            : "Queue searches for these items at " + scopeLabel)
                        }
                        onClick={() =>
                          research.mutate({ status: status as ResearchStatus, sourceId: scopeId })
                        }
                      >
                        {searching ? "Searching…" : "Search now"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="library-heading" className="border-t border-neutral-200 pt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <h2 id="library-heading" className="text-sm font-semibold text-neutral-900">
                Library
              </h2>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-neutral-600">
                <span className="tabular-nums">{scopeTotal} files tracked</span>
                <button
                  type="button"
                  onClick={() => goLibrary("unchecked")}
                  className="transition-colors hover:text-neutral-900 hover:underline hover:underline-offset-2"
                >
                  Unchecked <span className="tabular-nums text-neutral-900">{byStatus.unchecked ?? 0}</span>
                </button>
                <button
                  type="button"
                  onClick={() => goLibrary("healthy")}
                  className="transition-colors hover:text-neutral-900 hover:underline hover:underline-offset-2"
                >
                  Healthy <span className="tabular-nums text-neutral-900">{byStatus.healthy ?? 0}</span>
                </button>
              </div>
            </div>
          </section>

          <section aria-labelledby="checks-heading" className="space-y-4 border-t border-neutral-200 pt-6">
            <h2 id="checks-heading" className="sr-only">
              Scan history and how checks work
            </h2>
            <p className="text-xs text-neutral-500">
              {lastScan
                ? "Last scan " +
                  formatRelative(lastScan.finishedAt ?? lastScan.startedAt) +
                  ": " +
                  (lastScan.scope === "all" ? "everything" : lastScan.scope) +
                  " scope, " +
                  lastScan.done +
                  " files checked, " +
                  lastScan.issues +
                  " with issues."
                : "No scan has run yet."}
            </p>
            <details className="text-sm text-neutral-600">
              <summary className="w-fit cursor-pointer select-none font-medium text-neutral-700 hover:text-neutral-900">
                How checks work
              </summary>
              <p className="mt-2 max-w-prose text-sm leading-6">
                Every file is probed with ffprobe, then decoded with ffmpeg: one second at the start, one
                second from the middle (50% of duration), and one second from 99% of the way to the end. Files
                that fail to decode are marked corrupt; files with recoverable errors or no known duration are
                marked suspect.
              </p>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
