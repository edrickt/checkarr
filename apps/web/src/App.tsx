import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCancelScan } from "./useScan";
import { useScanState, useStats } from "./hooks";
import { useHashRoute, type Tab } from "./router";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { ToastProvider } from "./ui/Toast";
import { Button } from "./ui/Button";
import Dashboard from "./components/Dashboard";
import LibraryTable from "./components/LibraryTable";
import SettingsPage from "./components/SettingsPage";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" }
];

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Shell() {
  const { route, navigate } = useHashRoute();
  const queryClient = useQueryClient();
  const scan = useScanState();
  const stats = useStats();
  const cancelScan = useCancelScan();

  const active = scan.data?.active ?? false;
  const run = scan.data?.run ?? null;
  const tab = route.tab;
  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  const runLabel =
    run?.state === "cancelling"
      ? "Cancelling scan…"
      : run?.state === "starting"
        ? "Starting scan…"
        : run?.sourceName
          ? run.sourceName + " scan running"
          : "Scan running";

  // Library rows are only invalidated at scan start; push a refresh through
  // the moment a scan settles so the table reflects the new verdicts.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    }
    wasActive.current = active;
  }, [active, queryClient]);

  // Status rows deep-link into the library scoped the way the dashboard
  // counts them: same status, same library, no leftover search text.
  const goLibrary = (status: string) => {
    navigate((r) => ({
      ...r,
      tab: "library",
      library: { ...r.library, status, sourceId: r.scope, q: "", page: 1 }
    }));
  };

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-stretch gap-4 px-4 sm:gap-6 sm:px-6">
          <span className="flex shrink-0 items-center text-[15px] font-semibold tracking-tight">
            Checkarr
          </span>
          <nav aria-label="Main" className="flex gap-1">
            {TABS.map((t) => {
              const current = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => navigate((r) => ({ ...r, tab: t.id }))}
                  aria-current={current ? "page" : undefined}
                  className={
                    "border-b-2 px-2 text-sm transition-colors sm:px-3 " +
                    (current
                      ? "border-neutral-900 font-medium text-neutral-900"
                      : "border-transparent text-neutral-600 hover:text-neutral-900")
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
          <div className="ml-auto hidden items-center text-xs text-neutral-500 sm:flex">
            {active && run ? (
              <span className="tabular-nums">
                {run.state === "starting" ? "Starting…" : run.done + " / " + run.total + " checked"}
              </span>
            ) : stats.data ? (
              <span className="tabular-nums">{stats.data.total} files tracked</span>
            ) : null}
          </div>
        </div>
        {active && run && (
          <div className="border-t border-neutral-200">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-neutral-600 sm:px-6">
              <span className="font-medium text-neutral-900">{runLabel}</span>
              {run.state !== "starting" && (
                <span className="tabular-nums">
                  {run.done} / {run.total} checked · {run.issues} with issues
                </span>
              )}
              <div className="h-0.5 flex-1 bg-neutral-200">
                <div
                  className="h-full bg-neutral-900 transition-[width] duration-200"
                  style={{ width: pct + "%" }}
                />
              </div>
              <span className="w-9 text-right tabular-nums">{pct}%</span>
              <Button
                size="sm"
                variant="dangerOutline"
                onClick={() => cancelScan.mutate()}
                disabled={cancelScan.isPending || run.state === "cancelling"}
              >
                {cancelScan.isPending || run.state === "cancelling" ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {tab === "dashboard" && (
          <Dashboard
            scope={route.scope}
            onScopeChange={(v) => navigate((r) => ({ ...r, scope: v }), { replace: true })}
            goLibrary={goLibrary}
            goSettings={() => navigate((r) => ({ ...r, tab: "settings" }))}
          />
        )}
        {tab === "library" && (
          <div>
            <header className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Library</h1>
              <p className="mt-1 text-sm text-neutral-600">Search, filter, and act on every tracked file.</p>
            </header>
            <LibraryTable
              query={route.library}
              onQueryChange={(patch) =>
                navigate((r) => ({ ...r, library: { ...r.library, ...patch } }), { replace: true })
              }
            />
          </div>
        )}
        {tab === "settings" && (
          <div>
            <header className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Settings</h1>
              <p className="mt-1 text-sm text-neutral-600">
                Sources, checker configuration, path mappings, and network.
              </p>
            </header>
            <SettingsPage />
          </div>
        )}
      </main>
    </div>
  );
}
