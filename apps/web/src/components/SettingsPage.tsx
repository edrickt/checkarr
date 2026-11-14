import { useEffect, useState, type ReactNode } from "react";
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

const TYPE_LABEL: Record<Source["type"], string> = { radarr: "Radarr", sonarr: "Sonarr" };

/** One page section: 14px semibold heading, one-line muted description, content. */
function Section({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
      <p className="mt-1 text-xs text-neutral-500">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * A visible label + control + optional 12px help/error line. Labels carry the
 * accessible name (not placeholders), so every field reads the same way.
 */
function Field({
  id,
  label,
  help,
  error,
  className = "",
  children
}: {
  id?: string;
  label: string;
  help?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={"min-w-0 " + className}>
      <label htmlFor={id} className="block text-xs text-neutral-700">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {help && (
        <p id={id ? id + "-help" : undefined} className="mt-1 text-xs text-neutral-500">
          {help}
        </p>
      )}
      {error && (
        <p id={id ? id + "-error" : undefined} className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const settings = useSettingsQuery();
  const sources = useSources();
  const scan = useScanState();
  const active = scan.data?.active ?? false;
  // An explicit HOST env var (Docker) overrides the local-broadcast setting:
  // saving a change would always 400, so the control is disabled instead.
  const hostFromEnv = settings.data?.server.hostFromEnv ?? false;

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
  // Client-side guards mirror the server's 400s so an empty number field or
  // an empty mapping row disables Save instead of round-tripping an error.
  const concurrencyValid = Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32;
  const mappingsValid = mappings.every((m) => m.match.trim().length > 0);
  const formValid = concurrencyValid && mappingsValid;

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
    <div className="space-y-10">
      {settings.isError && (
        <ErrorBanner>
          Could not load settings: {(settings.error as Error)?.message ?? "unknown error"} - saving is
          disabled so your real configuration is not overwritten.
        </ErrorBanner>
      )}
      {sources.isError && (
        <ErrorBanner>
          Could not load sources: {(sources.error as Error)?.message ?? "unknown error"} - the list below is
          incomplete and adding a source may duplicate an existing one.
        </ErrorBanner>
      )}

      <Section
        title="Libraries"
        description="Radarr and Sonarr instances that Checkarr syncs its library from."
      >
        <div className="divide-y divide-neutral-200 border-y border-neutral-200">
          {(sources.data?.sources ?? []).map((s) => (
            <div key={s.id} className="py-4">
              {editing && editing.id === s.id ? (
                <div role="group" aria-label={"Edit " + editing.name} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0">
                      <div className="text-xs text-neutral-700">Type</div>
                      <div className="mt-1 text-sm text-neutral-600">{TYPE_LABEL[editing.type]}</div>
                      <p className="mt-1 text-xs text-neutral-500">
                        Fixed at creation - remove and re-add the source to change it.
                      </p>
                    </div>
                    <Field id={"source-" + editing.id + "-name"} label="Name">
                      <Input
                        id={"source-" + editing.id + "-name"}
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        placeholder="Main Radarr"
                        className="w-full"
                      />
                    </Field>
                    <Field id={"source-" + editing.id + "-url"} label="URL">
                      <Input
                        id={"source-" + editing.id + "-url"}
                        value={editing.baseUrl}
                        onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                        placeholder="http://localhost:7878"
                        className="w-full"
                      />
                    </Field>
                    <Field
                      id={"source-" + editing.id + "-api-key"}
                      label="API key"
                      help="The saved key is masked - retype it to replace it."
                    >
                      <Input
                        id={"source-" + editing.id + "-api-key"}
                        value={editing.apiKey}
                        onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                        placeholder="API key"
                        className="w-full"
                      />
                    </Field>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => updateSource.mutate(editing)} disabled={updateSource.isPending}>
                      {updateSource.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-xs text-neutral-500">{TYPE_LABEL[s.type]}</span>
                        <span className="text-sm font-medium text-neutral-900">{s.name}</span>
                        <span className="min-w-0 break-all font-mono text-xs text-neutral-500">
                          {s.baseUrl}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-neutral-500">
                        Last sync: {formatRelative(s.lastSyncAt)}
                        {s.lastSyncError && <span className="text-red-700"> - {s.lastSyncError}</span>}
                      </div>
                      {testResults[s.id] && (
                        <div
                          className={
                            "mt-1 text-xs " +
                            (testResults[s.id].startsWith("OK") ? "text-emerald-600" : "text-red-700")
                          }
                        >
                          {testResults[s.id]}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-neutral-500">
                        {s.enabled === 1 ? "Enabled" : "Disabled"}
                      </span>
                      <Toggle
                        checked={s.enabled === 1}
                        onChange={() => toggleEnabled.mutate(s)}
                        disabled={togglingId === s.id}
                        label={(s.enabled === 1 ? "Disable " : "Enable ") + s.name}
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => testSource.mutate(s.id)} disabled={testingId === s.id}>
                      {testingId === s.id ? "Testing..." : "Test connection"}
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
                      variant="dangerOutline"
                      onClick={() => void confirmDeleteSource(s)}
                      disabled={deletingId === s.id}
                    >
                      {deletingId === s.id ? "Removing..." : "Remove"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
          {sources.isLoading && !sources.data && (
            <div className="py-4 text-sm text-neutral-500">Loading sources...</div>
          )}
          {!sources.isLoading && !sources.isError && (sources.data?.sources ?? []).length === 0 && (
            <div className="py-4 text-sm text-neutral-500">No sources configured yet.</div>
          )}
        </div>

        <div className="mt-6 space-y-3">
          <h3 className="text-sm font-medium text-neutral-900">Add a source</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="add-source-type" label="Type">
              <Select
                id="add-source-type"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full"
              >
                <option value="radarr">Radarr</option>
                <option value="sonarr">Sonarr</option>
              </Select>
            </Field>
            <Field id="add-source-name" label="Name">
              <Input
                id="add-source-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Main Radarr"
                className="w-full"
              />
            </Field>
            <Field id="add-source-url" label="URL">
              <Input
                id="add-source-url"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="http://localhost:7878"
                className="w-full"
              />
            </Field>
            <Field id="add-source-api-key" label="API key" help="Settings > General in the *arr.">
              <Input
                id="add-source-api-key"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="API key (Settings > General in *arr)"
                className="w-full"
              />
            </Field>
          </div>
          <Button variant="primary" onClick={() => addSource.mutate()} disabled={addSource.isPending}>
            {addSource.isPending ? "Adding..." : "Add source"}
          </Button>
        </div>
      </Section>

      <form
        className="space-y-10"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Section
          title="Checker"
          description="How many files are checked at once, and which ffmpeg binaries do the checking."
        >
          {settings.data && !settings.data.ffmpegAvailable && (
            <p className="mb-3 text-sm text-red-700">ffmpeg is not available: {settings.data.ffmpegError}</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="settings-concurrency"
              label="Concurrency (1–32)"
              help="How many files are checked at the same time."
              error={concurrencyValid ? undefined : "Enter a whole number from 1 to 32."}
            >
              <Input
                id="settings-concurrency"
                type="number"
                min={1}
                max={32}
                value={Number.isNaN(concurrency) ? "" : concurrency}
                onChange={(e) => setConcurrency(e.target.value === "" ? Number.NaN : Number(e.target.value))}
                aria-invalid={!concurrencyValid}
                aria-describedby={
                  "settings-concurrency-help" + (concurrencyValid ? "" : " settings-concurrency-error")
                }
                className="w-full max-w-[8rem]"
              />
            </Field>
            {settings.data && (
              <div className="min-w-0">
                <div className="text-xs text-neutral-700">Resolved binaries</div>
                <div className="mt-1 space-y-0.5 text-xs text-neutral-500">
                  <div className="break-all font-mono">ffmpeg: {settings.data.resolved.ffmpeg}</div>
                  <div className="break-all font-mono">ffprobe: {settings.data.resolved.ffprobe}</div>
                </div>
              </div>
            )}
            <Field
              id="settings-ffmpeg-path"
              label="ffmpeg path"
              help="Leave blank to use the bundled binary."
            >
              <Input
                id="settings-ffmpeg-path"
                value={ffmpegPath}
                onChange={(e) => setFfmpegPath(e.target.value)}
                placeholder="bundled binary"
                className="w-full"
              />
            </Field>
            <Field
              id="settings-ffprobe-path"
              label="ffprobe path"
              help="Leave blank to use the bundled binary."
            >
              <Input
                id="settings-ffprobe-path"
                value={ffprobePath}
                onChange={(e) => setFfprobePath(e.target.value)}
                placeholder="bundled binary"
                className="w-full"
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Path mappings"
          description="Rewrite paths reported by Radarr or Sonarr (for example container paths) to paths this machine can read. First matching rule wins."
        >
          <div className="space-y-2">
            {mappings.length > 0 && (
              <div className="hidden gap-2 text-xs text-neutral-500 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem]">
                <span>From (*arr path)</span>
                <span>To (local path)</span>
                <span aria-hidden="true" />
              </div>
            )}
            {mappings.map((m, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem]">
                <Input
                  size="sm"
                  value={m.match}
                  onChange={(e) =>
                    setMappings(mappings.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))
                  }
                  placeholder="/movies (from *arr)"
                  aria-label={"From path " + (i + 1)}
                  aria-invalid={!mappingsValid && m.match.trim().length === 0}
                  aria-describedby={mappingsValid ? undefined : "path-mappings-error"}
                  className="w-full font-mono"
                />
                <Input
                  size="sm"
                  value={m.replace}
                  onChange={(e) =>
                    setMappings(mappings.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))
                  }
                  placeholder="/data/movies (local)"
                  aria-label={"To path " + (i + 1)}
                  className="w-full font-mono"
                />
                <Button
                  size="sm"
                  variant="dangerOutline"
                  onClick={() => setMappings(mappings.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          {!mappingsValid && (
            <p id="path-mappings-error" className="mt-2 text-xs text-red-700">
              Every path mapping needs a non-empty “from *arr” value.
            </p>
          )}
          <Button
            size="sm"
            className="mt-2"
            onClick={() => setMappings([...mappings, { match: "", replace: "" }])}
          >
            Add mapping
          </Button>
        </Section>

        <Section
          title="Network & server"
          description="How the dashboard is reached on your network, and when the server restarts."
        >
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-neutral-700">Local broadcasting</span>
                <Toggle
                  checked={localBroadcast}
                  onChange={setLocalBroadcast}
                  disabled={settings.isLoading || settings.isError || hostFromEnv}
                  label="Local broadcasting"
                  title={
                    (localBroadcast ? "Listening on all network interfaces" : "Listening on localhost only") +
                    " - takes effect after a restart"
                  }
                />
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Listen on all network interfaces instead of localhost only, so other devices on your network
                can open the dashboard. The API has no authentication - only enable this on networks you
                trust. Takes effect after a restart.
              </p>
              {settings.data?.server.hostFromEnv && (
                <p className="mt-1 text-xs text-amber-600">
                  Overridden by the HOST environment variable - the toggle has no effect in this deployment.
                </p>
              )}
            </div>
            {settings.data && (
              <p className="text-xs text-neutral-500">
                Listening on{" "}
                <span className="break-all font-mono text-neutral-600">
                  {settings.data.server.host}:{settings.data.server.port}
                </span>
                {settings.data.server.broadcasting
                  ? " - reachable from other devices on your network"
                  : " - localhost only"}
                {settings.data.server.hostFromEnv ? " (fixed by the HOST environment variable)" : ""}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void confirmRestart()} disabled={restart.isPending}>
                {restart.isPending ? "Restarting..." : "Restart server"}
              </Button>
              <span className="text-xs text-neutral-500">
                Applies the saved local-broadcast setting; the UI comes back after a few seconds.
              </span>
            </div>
          </div>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            type="submit"
            disabled={save.isPending || settings.isLoading || settings.isError || !dirty || !formValid}
            title={
              settings.isError
                ? "Settings failed to load - saving would overwrite your config"
                : !dirty
                  ? "No changes to save"
                  : !formValid
                    ? "Fix the highlighted fields before saving"
                    : undefined
            }
          >
            {save.isPending ? "Saving..." : "Save changes"}
          </Button>
          <span className="text-xs text-neutral-500">
            Saves the checker, path mapping and broadcasting settings together.
          </span>
        </div>
      </form>
    </div>
  );
}
