import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCancelScan } from "./useScan";
import { useScanState, useStats } from "./hooks";
import { useHashRoute, type Tab } from "./router";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { ToastProvider } from "./ui/Toast";
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

  // Library rows are only invalidated at scan start; push a refresh through
  // the moment a scan settles so the table reflects the new verdicts.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    }
    wasActive.current = active;
  }, [active, queryClient]);

  // Status cards deep-link into the library scoped the way the dashboard
  // counts them: same status, same server, no leftover search text.
  const goLibrary = (status: string) => {
    navigate((r) => ({
      ...r,
      tab: "library",
      library: { ...r.library, status, sourceId: r.scope, q: "", page: 1 }
    }));
  };

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-6xl items-stretch gap-8 px-4">
          <div className="flex items-baseline gap-2 py-3">
            <span className="text-base font-semibold tracking-tight">Checkarr</span>
            <span className="text-xs text-neutral-400">media integrity</span>
          </div>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => navigate((r) => ({ ...r, tab: t.id }))}
                className={
                  "border-b-2 px-3 py-3 text-sm " +
                  (tab === t.id
                    ? "border-neutral-900 font-medium text-neutral-900"
                    : "border-transparent text-neutral-400 hover:border-neutral-300 hover:text-neutral-900")
                }
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center text-xs text-neutral-400">
            {stats.data ? stats.data.total + " files tracked" : ""}
          </div>
        </div>
        {active && run && (
          <div className="border-t border-neutral-200">
            <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-xs text-neutral-500">
              <span className="font-medium text-neutral-900">
                {run.state === "cancelling"
                  ? "Cancelling scan..."
                  : run.state === "starting"
                    ? "Starting scan..."
                    : run.sourceName
                      ? run.sourceName + " scan running"
                      : "Scan running"}
              </span>
              {run.state !== "starting" && (
                <span>
                  {run.done} / {run.total} checked - {run.issues} with issues
                </span>
              )}
              <div className="h-1 flex-1 bg-neutral-200">
                <div className="h-full bg-neutral-900" style={{ width: pct + "%" }} />
              </div>
              <span className="tabular-nums">{pct}%</span>
              <button
                onClick={() => cancelScan.mutate()}
                disabled={cancelScan.isPending || run.state === "cancelling"}
                className="border border-neutral-300 bg-white px-2 py-0.5 text-neutral-600 hover:border-red-600 hover:text-red-600 disabled:opacity-40"
              >
                {cancelScan.isPending || run.state === "cancelling" ? "Cancelling..." : "Cancel"}
              </button>
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "dashboard" && (
          <Dashboard
            scope={route.scope}
            onScopeChange={(v) => navigate((r) => ({ ...r, scope: v }), { replace: true })}
            goLibrary={goLibrary}
            goSettings={() => navigate((r) => ({ ...r, tab: "settings" }))}
          />
        )}
        {tab === "library" && (
          <LibraryTable
            query={route.library}
            onQueryChange={(patch) =>
              navigate((r) => ({ ...r, library: { ...r.library, ...patch } }), { replace: true })
            }
          />
        )}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
