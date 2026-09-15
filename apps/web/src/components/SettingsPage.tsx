import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type SourceInput } from "../api";
import type { PathMapping, Source } from "../types";
import { formatRelative } from "../utils";
import { useScanState, useSettingsQuery, useSources } from "../hooks";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/controls";
import { useConfirm } from "../ui/ConfirmDialog";
import { ErrorBanner } from "../ui/ErrorBanner";
import { Toggle } from "../ui/Toggle";
import { useToast } from "../ui/Toast";
const EMPTY_FORM: SourceInput = { type: "radarr", name: "", baseUrl: "", apiKey: "" };

const TYPE_CHIP =
  "inline-block cursor-default border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-400";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const settings = useSettingsQuery();
  const sources = useSources();
  const scan = useScanState();
  const active = scan.data?.active ?? false;

  const [concurrency, setConcurrency] = useState(8);
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffprobePath, setFfprobePath] = useState("");
  const [mappings, setMappings] = useState<PathMapping[]>([]);
  const [localBroadcast, setLocalBroadcast] = useState(false);
  const [form, setForm] = useState<SourceInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<Source | null>(null);
  const [testResults, setTestResults] = useState<Record<number, string>>({});

  useEffect(() => {
    if (settings.data) {
      setConcurrency(settings.data.settings.concurrency);
      setFfmpegPath(settings.data.settings.ffmpegPath ?? "");
      setFfprobePath(settings.data.settings.ffprobePath ?? "");
      setMappings(settings.data.settings.pathMappings.map((m) => ({ ...m })));
      setLocalBroadcast(settings.data.settings.localBroadcast);
    }
  }, [settings.data]);

  // One form, one save: checker fields and path mappings save together, so
  // the button only lights up when the form actually differs from the server.
  const dirty =
    settings.data !== undefined &&
    (concurrency !== settings.data.settings.concurrency ||
      ffmpegPath !== (settings.data.settings.ffmpegPath ?? "") ||
      ffprobePath !== (settings.data.settings.ffprobePath ?? "") ||
      JSON.stringify(mappings) !== JSON.stringify(settings.data.settings.pathMappings) ||
      localBroadcast !== settings.data.settings.localBroadcast);

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
        pathMappings: mappings,
        localBroadcast
      }),
    onSuccess: () => {
      toast.success(
        localBroadcast ? "Settings saved - restart to apply local broadcasting" : "Settings saved"
      );
      invalidate();
    },
    onError: (err: Error) => toast.error("Save failed: " + err.message)
  });

  // The server answers the restart request before bouncing the listener, so
  // poll the API until it comes back up (or give up after a grace period).
  const restart = useMutation({
    mutationFn: () => api.restartServer(),
    onSuccess: async () => {
      toast.success("Restarting the server...");
      const deadline = Date.now() + 15_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          await api.settings();
          break;
        } catch {
          if (Date.now() > deadline) {
            toast.error("Server did not come back within 15s - check the server logs");
            return;
          }
        }
      }
      toast.success("Server restarted");
      invalidate();
    },
    onError: (err: Error) => toast.error("Restart failed: " + err.message)
  });

  const confirmRestart = async () => {
    const ok = await confirm({
      title: "Restart the server?",
      body:
        "The web UI goes down for a few seconds. Any saved local-broadcast change takes effect now; " +
        "a running scan keeps going.",
      confirmLabel: "Restart"
    });
    if (ok) restart.mutate();
  };

  const addSource = useMutation({
    mutationFn: () => api.addSource(form),
    onSuccess: () => {
      toast.success("Source added - test it, then sync");
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (err: Error) => toast.error("Add failed: " + err.message)
  });

  const updateSource = useMutation({
    mutationFn: (s: Source) => api.updateSource(s.id, { name: s.name, baseUrl: s.baseUrl, apiKey: s.apiKey }),
    onSuccess: () => {
      toast.success("Source updated");
      setEditing(null);
      invalidate();
    },
    onError: (err: Error) => toast.error("Update failed: " + err.message)
  });

  // Optimistic flip so the switch reacts instantly; rollback plus an error
  // toast if the server disagrees.
  const toggleEnabled = useMutation({
    mutationFn: (s: Source) => api.updateSource(s.id, { enabled: !s.enabled }),
    onMutate: async (s) => {
      await queryClient.cancelQueries({ queryKey: ["sources"] });
      const prev = queryClient.getQueryData<{ sources: Source[] }>(["sources"]);
      queryClient.setQueryData<{ sources: Source[] }>(["sources"], (old) =>
        old
          ? { sources: old.sources.map((x) => (x.id === s.id ? { ...x, enabled: s.enabled ? 0 : 1 } : x)) }
          : old
      );
      return { prev };
    },
    onError: (err: Error, s, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["sources"], ctx.prev);
      toast.error("Could not update " + s.name + ": " + err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sources"] })
  });

  const deleteSource = useMutation({
    mutationFn: (s: Source) => api.deleteSource(s.id),
    onSuccess: (_data, s) => {
      toast.success("Source '" + s.name + "' deleted");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => toast.error("Delete failed: " + err.message)
  });

  const confirmDeleteSource = async (s: Source) => {
    const ok = await confirm({
      title: "Delete source '" + s.name + "'?",
      body: "Its tracked files are removed from Checkarr. The *arr itself is not touched.",
      confirmLabel: "Delete source",
      danger: true
    });
    if (ok) deleteSource.mutate(s);
  };

  const testSource = useMutation({
    mutationFn: (id: number) => api.testSource(id),
    onSuccess: (r, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: r.ok
          ? "OK: " +
            (r.appName ?? "unknown app") +
            " " +
            (r.version ?? "") +
            (r.mismatch ? " (warning: app type mismatch)" : "")
          : "FAILED: " + (r.error ?? "unknown error")
      }));
    },
    onError: (err: Error) => toast.error("Test failed: " + err.message)
  });

  const syncSource = useMutation({
    mutationFn: (id: number) => api.sync(id),
    onSuccess: (data) => {
      const r = data.results[0];
      if (r?.ok) {
        toast.success(
          r.name +
            ": +" +
            (r.added ?? 0) +
            " new" +
            ((r.relinked ?? 0) > 0 ? ", " + r.relinked + " relinked to new downloads" : "") +
            ", " +
            (r.updated ?? 0) +
            " updated, -" +
            (r.removed ?? 0) +
            " removed"
        );
      } else {
        toast.error("Sync failed: " + (r?.error ?? "unknown error"));
      }
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => toast.error("Sync failed: " + err.message)
  });

  // Which source row is busy, so only that row's buttons react to the click.
  const testingId = testSource.isPending ? testSource.variables : null;
  const syncingId = syncSource.isPending ? syncSource.variables : null;
  const deletingId = deleteSource.isPending ? deleteSource.variables?.id : null;
  const togglingId = toggleEnabled.isPending ? toggleEnabled.variables?.id : null;

  return (
    <div className="space-y-8">
      {settings.isError && (
        <ErrorBanner>
          Could not load settings: {(settings.error as Error)?.message ?? "unknown error"} - saving is
          disabled so your real configuration is not overwritten.
        </ErrorBanner>
      )}

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Sources</h2>
        <div className="divide-y divide-neutral-200 border-y border-neutral-200">
          {(sources.data?.sources ?? []).map((s) => (
            <div key={s.id} className="py-4">
              {editing && editing.id === s.id ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <span
                      className={TYPE_CHIP}
                      title="The source type is fixed at creation - delete and re-add to change it"
                    >
                      {editing.type}
                    </span>
                    <Input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      placeholder="Name"
                      className="max-w-xs"
                    />
                  </div>
                  <Input
                    value={editing.baseUrl}
                    onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                    placeholder="http://localhost:7878"
                  />
                  <Input
                    value={editing.apiKey}
                    onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                    placeholder="API key"
                    title="Saved key is masked - retype it to replace"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => updateSource.mutate(editing)}
                      disabled={updateSource.isPending}
                    >
                      {updateSource.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-neutral-400">{s.type}</span>
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-neutral-400">{s.baseUrl}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-neutral-400">
                        {s.enabled === 1 ? "Enabled" : "Disabled"}
                      </span>
                      <Toggle
                        checked={s.enabled === 1}
                        onChange={() => toggleEnabled.mutate(s)}
                        disabled={togglingId === s.id}
                        label={(s.enabled === 1 ? "Disable " : "Enable ") + s.name}
                      />
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-neutral-400">
                    last sync: {formatRelative(s.lastSyncAt)}
                    {s.lastSyncError && <span className="text-red-600"> - {s.lastSyncError}</span>}
                  </div>
                  {testResults[s.id] && (
                    <div
                      className={
                        "mt-1 text-xs " +
                        (testResults[s.id].startsWith("OK") ? "text-emerald-600" : "text-red-600")
                      }
                    >
                      {testResults[s.id]}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => testSource.mutate(s.id)} disabled={testingId === s.id}>
                      {testingId === s.id ? "Testing..." : "Test"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => syncSource.mutate(s.id)}
                      disabled={syncingId === s.id || active}
                      title={active ? "A scan is running - wait for it to finish or cancel it" : undefined}
                    >
                      {syncingId === s.id ? "Syncing..." : "Sync"}
                    </Button>
                    <Button size="sm" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void confirmDeleteSource(s)}
                      disabled={deletingId === s.id}
                    >
                      {deletingId === s.id ? "Deleting..." : "Delete"}
                    </Button>
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
            <Select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              aria-label="Source type"
            >
              <option value="radarr">Radarr</option>
              <option value="sonarr">Sonarr</option>
            </Select>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name (e.g. Main Radarr)"
            />
            <Input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="http://localhost:7878"
            />
            <Input
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="API key (Settings > General in *arr)"
            />
          </div>
          <Button
            variant="primary"
            className="mt-3"
            onClick={() => addSource.mutate()}
            disabled={addSource.isPending}
          >
            {addSource.isPending ? "Adding..." : "Add source"}
          </Button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">
          Checker settings
        </h2>
        {settings.data && !settings.data.ffmpegAvailable && (
          <div className="mb-3 border border-red-300 px-3 py-2 text-xs text-red-700">
            {settings.data.ffmpegError}
          </div>
        )}
        {settings.data && (
          <div className="mb-3 text-xs text-neutral-400">
            resolved: ffmpeg ={" "}
            <span className="font-mono text-neutral-600">{settings.data.resolved.ffmpeg}</span>, ffprobe ={" "}
            <span className="font-mono text-neutral-600">{settings.data.resolved.ffprobe}</span>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-neutral-400">
              Concurrent checks (1-32)
              <Input
                type="number"
                min={1}
                max={32}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="mt-1"
              />
            </label>
            <label className="text-xs text-neutral-400">
              ffmpeg path override
              <Input
                value={ffmpegPath}
                onChange={(e) => setFfmpegPath(e.target.value)}
                placeholder="bundled binary"
                className="mt-1"
              />
            </label>
            <label className="text-xs text-neutral-400">
              ffprobe path override
              <Input
                value={ffprobePath}
                onChange={(e) => setFfprobePath(e.target.value)}
                placeholder="bundled binary"
                className="mt-1"
              />
            </label>
          </div>

          <div className="mt-4 flex items-start justify-between gap-4 border border-neutral-200 p-3">
            <div>
              <div className="text-sm font-medium">Local broadcasting</div>
              <div className="mt-0.5 text-xs text-neutral-400">
                Listen on all network interfaces instead of localhost only, so other devices on your network
                can open the dashboard. Note the API has no authentication - only enable this on networks you
                trust. Takes effect after a restart.
              </div>
              {settings.data?.server.hostFromEnv && (
                <div className="mt-1 text-xs text-amber-600">
                  Overridden by the HOST environment variable - the toggle has no effect in this deployment.
                </div>
              )}
            </div>
            <Toggle
              checked={localBroadcast}
              onChange={setLocalBroadcast}
              disabled={settings.isLoading || settings.isError}
              label="Local broadcasting"
            />
          </div>

          <div className="mt-4">
            <div className="text-xs text-neutral-400">
              Path mappings - rewrites paths reported by Radarr/Sonarr (e.g. container paths) to paths
              readable by Checkarr. First matching rule wins.
            </div>
            <div className="mt-2 space-y-2">
              {mappings.map((m, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input
                    value={m.match}
                    onChange={(e) =>
                      setMappings(mappings.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))
                    }
                    placeholder="/movies (from *arr)"
                    className="max-w-xs font-mono"
                  />
                  <span className="text-neutral-400">&#8594;</span>
                  <Input
                    value={m.replace}
                    onChange={(e) =>
                      setMappings(mappings.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))
                    }
                    placeholder="/data/movies (local)"
                    className="max-w-xs font-mono"
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setMappings(mappings.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => setMappings([...mappings, { match: "", replace: "" }])}
            >
              Add mapping
            </Button>
          </div>

          <Button
            variant="primary"
            type="submit"
            className="mt-4"
            disabled={save.isPending || settings.isLoading || settings.isError || !dirty}
            title={
              settings.isError
                ? "Settings failed to load - saving would overwrite your config"
                : !dirty
                  ? "No changes to save"
                  : undefined
            }
          >
            {save.isPending ? "Saving..." : "Save changes"}
          </Button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Server</h2>
        {settings.data && (
          <div className="text-xs text-neutral-400">
            listening on{" "}
            <span className="font-mono text-neutral-600">
              {settings.data.server.host}:{settings.data.server.port}
            </span>
            {settings.data.server.broadcasting
              ? " - reachable from other devices on your network"
              : " - localhost only"}
            {settings.data.server.hostFromEnv ? " (fixed by the HOST environment variable)" : ""}
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={() => void confirmRestart()} disabled={restart.isPending}>
            {restart.isPending ? "Restarting..." : "Restart server"}
          </Button>
          <span className="text-xs text-neutral-400">
            Applies the saved local-broadcast setting; the UI comes back after a few seconds.
          </span>
        </div>
      </section>
    </div>
  );
}
