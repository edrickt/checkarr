import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "../src/components/SettingsPage";
import { ConfirmProvider } from "../src/ui/ConfirmDialog";
import { ToastProvider } from "../src/ui/Toast";
import type { SettingsResponse, Source } from "../src/types";

const settingsMock = vi.fn();
const sourcesMock = vi.fn();
const saveSettingsMock = vi.fn();
const restartMock = vi.fn();
const addSourceMock = vi.fn();
const updateSourceMock = vi.fn();
const deleteSourceMock = vi.fn();
const testSourceMock = vi.fn();
const syncMock = vi.fn();

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: (...args: unknown[]) => settingsMock(...args),
      sources: (...args: unknown[]) => sourcesMock(...args),
      currentScan: async () => ({ run: null, active: false }),
      saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
      restartServer: (...args: unknown[]) => restartMock(...args),
      addSource: (...args: unknown[]) => addSourceMock(...args),
      updateSource: (...args: unknown[]) => updateSourceMock(...args),
      deleteSource: (...args: unknown[]) => deleteSourceMock(...args),
      testSource: (...args: unknown[]) => testSourceMock(...args),
      sync: (...args: unknown[]) => syncMock(...args)
    }
  };
});

const settingsResponse = (overrides: Partial<SettingsResponse["server"]> = {}): SettingsResponse => ({
  settings: {
    concurrency: 8,
    ffmpegPath: null,
    ffprobePath: null,
    pathMappings: [],
    localBroadcast: false
  },
  resolved: { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" },
  ffmpegAvailable: true,
  ffmpegError: null,
  server: { port: 5656, host: "127.0.0.1", broadcasting: false, hostFromEnv: false, ...overrides }
});

const radarr: Source = {
  id: 1,
  type: "radarr",
  name: "Main Radarr",
  baseUrl: "http://127.0.0.1:7878",
  apiKey: "\u2022\u2022\u2022\u20221234",
  enabled: 1,
  lastSyncAt: null,
  lastSyncError: null,
  createdAt: "2024-01-01T00:00:00Z"
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.mockResolvedValue(settingsResponse());
  sourcesMock.mockResolvedValue({ sources: [radarr] });
  saveSettingsMock.mockResolvedValue({ settings: settingsResponse().settings });
  restartMock.mockResolvedValue({ ok: true });
  addSourceMock.mockResolvedValue({ id: 2 });
  updateSourceMock.mockResolvedValue({ ok: true });
  deleteSourceMock.mockResolvedValue({ ok: true });
  testSourceMock.mockResolvedValue({ ok: true, appName: "Radarr", version: "5.2.6" });
  syncMock.mockResolvedValue({
    results: [{ sourceId: 1, name: "Main Radarr", ok: true, added: 3, updated: 1, removed: 0 }]
  });
});

describe("SettingsPage", () => {
  it("surfaces a sources load failure instead of claiming none are configured", async () => {
    sourcesMock.mockRejectedValue(new Error("HTTP 500"));
    renderPage();
    expect(await screen.findByText(/Could not load sources: HTTP 500/)).toBeInTheDocument();
    expect(screen.queryByText("No sources configured yet.")).not.toBeInTheDocument();
  });

  it("says the list is loading before it claims there are no sources", async () => {
    let resolveSources!: (value: unknown) => void;
    sourcesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSources = resolve;
      })
    );
    renderPage();
    expect(await screen.findByText("Loading sources...")).toBeInTheDocument();
    expect(screen.queryByText("No sources configured yet.")).not.toBeInTheDocument();
    resolveSources({ sources: [] });
    expect(await screen.findByText("No sources configured yet.")).toBeInTheDocument();
  });

  it("disables local broadcasting when the HOST environment variable overrides it", async () => {
    settingsMock.mockResolvedValue(settingsResponse({ hostFromEnv: true }));
    renderPage();
    expect(await screen.findByText(/Overridden by the HOST environment variable/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Local broadcasting" })).toBeDisabled();
  });

  it("leaves local broadcasting editable when only the setting controls it", async () => {
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Local broadcasting" });
    await waitFor(() => expect(toggle).toBeEnabled());
    // The source-enablement tooltip must not leak onto the network toggle.
    expect(toggle).toHaveAttribute("title", expect.stringMatching(/restart/));
    expect(toggle).not.toHaveAttribute("title", expect.stringMatching(/sync and actions/));
  });

  it("renders the four sections and names every checker field with a visible label", async () => {
    renderPage();
    await screen.findByText("Main Radarr");

    for (const heading of ["Libraries", "Checker", "Path mappings", "Network & server"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }

    expect(screen.getByLabelText("Concurrency (1–32)")).toHaveValue(8);
    expect(screen.getByLabelText("ffmpeg path")).toHaveValue("");
    expect(screen.getByLabelText("ffprobe path")).toHaveValue("");
    expect(screen.getByText("Resolved binaries")).toBeInTheDocument();
    expect(screen.getByText("ffmpeg: /usr/bin/ffmpeg")).toBeInTheDocument();
    expect(screen.getByText("ffprobe: /usr/bin/ffprobe")).toBeInTheDocument();
    // The resolved paths are shown in a wrapping mono block, not a wide one-liner.
    expect(screen.getByText("ffmpeg: /usr/bin/ffmpeg")).toHaveClass("break-all", "font-mono");
    expect(screen.getByText("ffprobe: /usr/bin/ffprobe")).toHaveClass("break-all", "font-mono");
  });

  it("tests a source connection and shows the result in the row", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(testSourceMock).toHaveBeenCalledWith(1);
    expect(await screen.findByText("OK: Radarr 5.2.6")).toBeInTheDocument();
  });

  it("syncs one source and reports the result", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");
    await user.click(screen.getByRole("button", { name: "Sync" }));
    expect(syncMock).toHaveBeenCalledWith(1);
    expect(await screen.findByText(/Main Radarr: \+3 new/)).toBeInTheDocument();
  });

  it("edits a source in place with labelled fields and saves it", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const group = screen.getByRole("group", { name: "Edit Main Radarr" });
    expect(within(group).getByLabelText("Name")).toHaveValue("Main Radarr");
    expect(within(group).getByLabelText("URL")).toHaveValue("http://127.0.0.1:7878");
    expect(within(group).getByLabelText("API key")).toHaveValue("\u2022\u2022\u2022\u20221234");

    await user.clear(within(group).getByLabelText("Name"));
    await user.type(within(group).getByLabelText("Name"), "Movies");
    await user.click(within(group).getByRole("button", { name: "Save" }));

    expect(updateSourceMock).toHaveBeenCalledWith(1, {
      name: "Movies",
      baseUrl: "http://127.0.0.1:7878",
      apiKey: "\u2022\u2022\u2022\u20221234"
    });
    expect(await screen.findByText("Source updated")).toBeInTheDocument();
  });

  it("adds a source from the labelled form", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");

    await user.selectOptions(screen.getByLabelText("Type"), "sonarr");
    await user.type(screen.getByLabelText("Name"), "Second Sonarr");
    await user.type(screen.getByLabelText("URL"), "http://127.0.0.1:8989");
    await user.type(screen.getByLabelText("API key"), "abc123");
    await user.click(screen.getByRole("button", { name: "Add source" }));

    expect(addSourceMock).toHaveBeenCalledWith({
      type: "sonarr",
      name: "Second Sonarr",
      baseUrl: "http://127.0.0.1:8989",
      apiKey: "abc123"
    });
    expect(await screen.findByText("Source added - test it, then sync")).toBeInTheDocument();
  });

  it("removes a source only after the confirm dialog is accepted", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("dialog", { name: "Delete source 'Main Radarr'?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete source" }));
    expect(deleteSourceMock).toHaveBeenCalledWith(1);
  });

  it("toggles a source optimistically without a confirm", async () => {
    const user = userEvent.setup();
    // Hold the response open so the optimistic flip is observable before the
    // sources query refetches and settles on the server's answer.
    updateSourceMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("switch", { name: "Disable Main Radarr" }));
    expect(updateSourceMock).toHaveBeenCalledWith(1, { enabled: false });
    expect(screen.getByRole("switch", { name: "Enable Main Radarr" })).toBeInTheDocument();
  });

  it("flags an out-of-range concurrency inline and keeps Save disabled", async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText("Concurrency (1–32)");
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "40");

    expect(await screen.findByText("Enter a whole number from 1 to 32.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(saveButton).toBeDisabled();
  });

  it("requires a non-empty from path in every mapping and unblocks Save once valid", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");
    const saveButton = screen.getByRole("button", { name: "Save changes" });

    await user.click(screen.getByRole("button", { name: "Add mapping" }));
    expect(screen.getByText("From (*arr path)")).toBeInTheDocument();
    expect(screen.getByText("To (local path)")).toBeInTheDocument();
    expect(screen.getByText(/Every path mapping needs a non-empty/)).toBeInTheDocument();
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByLabelText("From path 1"), "/movies");
    expect(screen.queryByText(/Every path mapping needs a non-empty/)).not.toBeInTheDocument();
    expect(saveButton).toBeEnabled();

    const mappingRow = screen.getByLabelText("From path 1").closest("div");
    expect(mappingRow).not.toBeNull();
    await user.click(within(mappingRow as HTMLDivElement).getByRole("button", { name: "Remove" }));
    expect(screen.queryByLabelText("From path 1")).not.toBeInTheDocument();
  });

  it("saves checker, mapping and broadcasting changes together only when dirty", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();

    const concurrency = screen.getByLabelText("Concurrency (1–32)");
    await user.clear(concurrency);
    await user.type(concurrency, "4");
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);
    expect(saveSettingsMock).toHaveBeenCalledWith({
      concurrency: 4,
      ffmpegPath: null,
      ffprobePath: null,
      pathMappings: [],
      localBroadcast: false
    });
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
  });

  it("confirms before restarting the server", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("button", { name: "Restart server" }));
    expect(screen.getByRole("dialog", { name: "Restart the server?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(restartMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restart server" }));
    await user.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(restartMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Restarting the server...")).toBeInTheDocument();
    expect(await screen.findByText("Server restarted", {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
