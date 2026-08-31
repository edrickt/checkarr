import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useCancelScan, useScanPollingGate } from "./useScan";
import Dashboard from "./components/Dashboard";
import LibraryTable from "./components/LibraryTable";
import SettingsPage from "./components/SettingsPage";

type Tab = "dashboard" | "library" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" }
];

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [libraryStatus, setLibraryStatus] = useState<string | null>(null);
  const [librarySource, setLibrarySource] = useState<string | null>(null);
  // Server picked on the Dashboard: "" = all servers, otherwise a source id.
  // Lives here so the choice survives leaving the Dashboard tab - the status
  // cards (and everything the scan/purge/sync buttons target) stay scoped to
  // that server instead of silently falling back to all servers.
  const [pickerSource, setPickerSource] = useState<string>("");
  const queryClient = useQueryClient();

  const scanPollPaused = useScanPollingGate();
  const scan = useQuery({
    queryKey: ["scan"],
    queryFn: api.currentScan,
    refetchInterval: scanPollPaused ? false : (q) => (q.state.data?.active ? 1500 : 5000)
  });
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: (q) => (q.state.data?.activeScan ? 1500 : 5000)
  });

  const cancelScan = useCancelScan();

  const goLibrary = (status: string | null, sourceId: string | null) => {
    setLibraryStatus(status);
    setLibrarySource(sourceId);
    setTab("library");
  };

  const run = scan.data?.run ?? null;
  const active = scan.data?.active ?? false;

  // Library rows are only invalidated at scan start; push a refresh through
  // the moment a scan settles so the table reflects the new verdicts.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    }
    wasActive.current = active;
  }, [active, queryClient]);
  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-6xl items-center gap-8 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Checkarr</span>
            <span className="text-xs text-neutral-400">media integrity</span>
          </div>
          <nav className="flex gap-5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={
                  "text-sm " +
                  (tab === t.id ? "font-medium text-neutral-900" : "text-neutral-400 hover:text-neutral-900")
                }
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto text-xs text-neutral-400">
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
            onGoLibrary={goLibrary}
            pickerSource={pickerSource}
            onPickerSourceChange={setPickerSource}
          />
        )}
        {tab === "library" && <LibraryTable initialStatus={libraryStatus} initialSourceId={librarySource} />}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
