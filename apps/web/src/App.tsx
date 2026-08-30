import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
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
  const queryClient = useQueryClient();

  const scan = useQuery({
    queryKey: ["scan"],
    queryFn: api.currentScan,
    refetchInterval: (q) => (q.state.data?.active ? 1500 : 5000)
  });
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: (q) => (q.state.data?.activeScan ? 1500 : 5000)
  });

  const cancelScan = useMutation({
    mutationFn: api.cancelScan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scan"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    }
  });

  const goLibrary = (status: string | null) => {
    setLibraryStatus(status);
    setTab("library");
  };

  const run = scan.data?.run ?? null;
  const active = scan.data?.active ?? false;
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
              <span className="font-medium text-neutral-900">{run.mode} scan running</span>
              <span>
                {run.done} / {run.total} checked - {run.issues} with issues
              </span>
              <div className="h-1 flex-1 bg-neutral-200">
                <div className="h-full bg-neutral-900" style={{ width: pct + "%" }} />
              </div>
              <span className="tabular-nums">{pct}%</span>
              <button
                onClick={() => cancelScan.mutate()}
                className="border border-neutral-300 px-2 py-0.5 text-neutral-600 hover:border-red-600 hover:text-red-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "dashboard" && <Dashboard onGoLibrary={goLibrary} />}
        {tab === "library" && <LibraryTable initialStatus={libraryStatus} />}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
