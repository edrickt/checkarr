import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SourceInput } from "../api";
import type { PathMapping, Source } from "../types";
import { formatWhen } from "../utils";

const EMPTY_FORM: SourceInput = { type: "radarr", name: "", baseUrl: "", apiKey: "" };

const INPUT = "w-full border border-neutral-300 bg-white px-3 py-1.5 text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none";
const BTN = "border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-40";
const BTN_PRIMARY = "bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources });

  const [concurrency, setConcurrency] = useState(8);
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffprobePath, setFfprobePath] = useState("");
  const [mappings, setMappings] = useState<PathMapping[]>([]);
  const [form, setForm] = useState<SourceInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<Source | null>(null);
  const [testResults, setTestResults] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setConcurrency(settings.data.settings.concurrency);
      setFfmpegPath(settings.data.settings.ffmpegPath ?? "");
      setFfprobePath(settings.data.settings.ffprobePath ?? "");
      setMappings(settings.data.settings.pathMappings.map((m) => ({ ...m })));
    }
  }, [settings.data]);

  const notify = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 6000);
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["sources"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        concurrency,
        ffmpegPath: ffmpegPath.trim() === "" ? null : ffmpegPath.trim(),
        ffprobePath: ffprobePath.trim() === "" ? null : ffprobePath.trim(),
        pathMappings: mappings
      }),
    onSuccess: () => {
      notify("Settings saved");
      invalidate();
    },
    onError: (err: Error) => notify("Save failed: " + err.message)
  });

  const addSource = useMutation({
    mutationFn: () => api.addSource(form),
    onSuccess: () => {
      notify("Source added - test it, then sync");
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (err: Error) => notify("Add failed: " + err.message)
  });

  const updateSource = useMutation({
    mutationFn: (s: Source) =>
      api.updateSource(s.id, { type: s.type, name: s.name, baseUrl: s.baseUrl, apiKey: s.apiKey }),
    onSuccess: () => {
      notify("Source updated");
      setEditing(null);
      invalidate();
    },
    onError: (err: Error) => notify("Update failed: " + err.message)
  });

  const deleteSource = useMutation({
    mutationFn: (id: number) => api.deleteSource(id),
    onSuccess: () => {
      notify("Source deleted");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => notify("Delete failed: " + err.message)
  });

  const testSource = useMutation({
    mutationFn: (id: number) => api.testSource(id),
    onSuccess: (r, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: r.ok
          ? "OK: " + (r.appName ?? "unknown app") + " " + (r.version ?? "") + (r.mismatch ? " (warning: app type mismatch)" : "")
          : "FAILED: " + (r.error ?? "unknown error")
      }));
    },
    onError: (err: Error) => notify("Test failed: " + err.message)
  });

  const syncSource = useMutation({
    mutationFn: (id: number) => api.sync(id),
    onSuccess: (data) => {
      const r = data.results[0];
      notify(r && r.ok ? r.name + ": +" + (r.added ?? 0) + " new, " + (r.updated ?? 0) + " updated, -" + (r.removed ?? 0) + " removed" : "Sync failed: " + (r?.error ?? "?"));
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => notify("Sync failed: " + err.message)
  });

  // Which source row is busy, so only that row's buttons react to the click.
  const testingId = testSource.isPending ? testSource.variables : null;
  const syncingId = syncSource.isPending ? syncSource.variables : null;
  const deletingId = deleteSource.isPending ? deleteSource.variables : null;

  return (
    <div className="space-y-8">
      {message && <div className="border border-neutral-200 px-4 py-3 text-sm text-neutral-600">{message}</div>}

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Sources</h2>
        <div className="divide-y divide-neutral-200 border-y border-neutral-200">
          {(sources.data?.sources ?? []).map((s) => (
            <div key={s.id} className="py-4">
              {editing && editing.id === s.id ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={editing.type}
                      onChange={(e) => setEditing({ ...editing, type: e.target.value as Source["type"] })}
                      className={INPUT + " max-w-xs"}
                    >
                      <option value="radarr">radarr</option>
                      <option value="sonarr">sonarr</option>
                    </select>
                    <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Name" className={INPUT + " max-w-xs"} />
                  </div>
                  <input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="http://localhost:7878" className={INPUT} />
                  <input value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="API key" title="Saved key is masked - retype it to replace" className={INPUT} />
                  <div className="flex gap-2">
                    <button onClick={() => updateSource.mutate(editing)} disabled={updateSource.isPending} className={BTN}>
                      {updateSource.isPending ? "Saving..." : "Save"}
                    </button>
                    <button onClick={() => setEditing(null)} className={BTN}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-xs uppercase tracking-wide text-neutral-400">{s.type}</span>
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-neutral-400">{s.baseUrl}</span>
                    {!s.enabled && <span className="text-xs text-amber-600">(disabled)</span>}
                  </div>
                  <div className="mt-1 text-xs text-neutral-400">
                    last sync: {formatWhen(s.lastSyncAt)}
                    {s.lastSyncError && <span className="text-red-600"> - {s.lastSyncError}</span>}
                  </div>
                  {testResults[s.id] && (
                    <div className={"mt-1 text-xs " + (testResults[s.id].startsWith("OK") ? "text-emerald-600" : "text-red-600")}>
                      {testResults[s.id]}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => testSource.mutate(s.id)} disabled={testingId === s.id} className={BTN}>
                      {testingId === s.id ? "Testing..." : "Test"}
                    </button>
                    <button onClick={() => syncSource.mutate(s.id)} disabled={syncingId === s.id} className={BTN}>
                      {syncingId === s.id ? "Syncing..." : "Sync"}
                    </button>
                    <button onClick={() => setEditing(s)} className={BTN}>Edit</button>
                    <button
                      onClick={() => {
                        if (window.confirm("Delete source '" + s.name + "' and its tracked files?")) deleteSource.mutate(s.id);
                      }}
                      disabled={deletingId === s.id}
                      className={BTN + " hover:border-red-600 hover:text-red-600"}
                    >
                      {deletingId === s.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {(sources.data?.sources ?? []).length === 0 && (
            <div className="py-4 text-sm text-neutral-400">No sources configured yet.</div>
          )}
        </div>

        <div className="mt-4 border border-dashed border-neutral-300 p-4">
          <div className="mb-2 text-sm font-medium">Add a source</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={INPUT}>
              <option value="radarr">radarr</option>
              <option value="sonarr">sonarr</option>
            </select>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name (e.g. Main Radarr)" className={INPUT} />
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://localhost:7878" className={INPUT} />
            <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="API key (Settings > General in *arr)" className={INPUT} />
          </div>
          <button onClick={() => addSource.mutate()} disabled={addSource.isPending} className={BTN_PRIMARY + " mt-3"}>
            {addSource.isPending ? "Adding..." : "Add source"}
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Checker settings</h2>
        {settings.data && !settings.data.ffmpegAvailable && (
          <div className="mb-3 border border-red-300 px-3 py-2 text-xs text-red-700">
            {settings.data.ffmpegError}
          </div>
        )}
        {settings.data && (
          <div className="mb-3 text-xs text-neutral-400">
            resolved: ffmpeg = <span className="font-mono text-neutral-600">{settings.data.resolved.ffmpeg}</span>, ffprobe ={" "}
            <span className="font-mono text-neutral-600">{settings.data.resolved.ffprobe}</span>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-neutral-400">
            Concurrent checks (1-32)
            <input
              type="number"
              min={1}
              max={32}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className={INPUT + " mt-1"}
            />
          </label>
          <label className="text-xs text-neutral-400">
            ffmpeg path override
            <input value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder="bundled binary" className={INPUT + " mt-1"} />
          </label>
          <label className="text-xs text-neutral-400">
            ffprobe path override
            <input value={ffprobePath} onChange={(e) => setFfprobePath(e.target.value)} placeholder="bundled binary" className={INPUT + " mt-1"} />
          </label>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className={BTN_PRIMARY + " mt-3"}>
          {save.isPending ? "Saving..." : "Save settings"}
        </button>
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-400">Path mappings</h2>
        <p className="mb-3 mt-1 text-xs text-neutral-400">
          Rewrites paths reported by Radarr/Sonarr (e.g. container paths) to paths readable by Checkarr. First matching rule wins.
        </p>
        {mappings.map((m, i) => (
          <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
            <input
              value={m.match}
              onChange={(e) => setMappings(mappings.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))}
              placeholder="/movies (from *arr)"
              className={INPUT + " max-w-xs font-mono"}
            />
            <span className="text-neutral-400">&#8594;</span>
            <input
              value={m.replace}
              onChange={(e) => setMappings(mappings.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))}
              placeholder="/data/movies (local)"
              className={INPUT + " max-w-xs font-mono"}
            />
            <button
              onClick={() => setMappings(mappings.filter((_, j) => j !== i))}
              className={BTN + " hover:border-red-600 hover:text-red-600"}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          onClick={() => setMappings([...mappings, { match: "", replace: "" }])}
          className={BTN + " mt-1"}
        >
          Add mapping
        </button>
        <div className="mt-3">
          <button onClick={() => save.mutate()} disabled={save.isPending} className={BTN_PRIMARY}>
            Save settings
          </button>
        </div>
      </section>
    </div>
  );
}
