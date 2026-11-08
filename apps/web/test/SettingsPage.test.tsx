import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "../src/components/SettingsPage";
import { ConfirmProvider } from "../src/ui/ConfirmDialog";
import { ToastProvider } from "../src/ui/Toast";
import type { SettingsResponse, Source } from "../src/types";

const settingsMock = vi.fn();
const sourcesMock = vi.fn();

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: (...args: unknown[]) => settingsMock(...args),
      sources: (...args: unknown[]) => sourcesMock(...args),
      currentScan: async () => ({ run: null, active: false })
    }
  };
});

const settingsResponse = (overrides: Partial<SettingsResponse["server"]> = {}): SettingsResponse => ({
  settings: { concurrency: 8, ffmpegPath: null, ffprobePath: null, pathMappings: [], localBroadcast: false },
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
});
