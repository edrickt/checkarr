import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "../src/components/Dashboard";
import { STATUS_META } from "../src/status";
import type { Source, Stats } from "../src/types";
import { ConfirmProvider } from "../src/ui/ConfirmDialog";
import { ToastProvider } from "../src/ui/Toast";

const statsMock = vi.fn();
const sourcesMock = vi.fn();

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      stats: (...args: unknown[]) => statsMock(...args),
      sources: (...args: unknown[]) => sourcesMock(...args),
      currentScan: async () => ({ run: null, active: false }),
      settings: async () => ({
        settings: { concurrency: 8, ffmpegPath: null, ffprobePath: null, pathMappings: [] },
        resolved: { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" },
        ffmpegAvailable: true,
        ffmpegError: null
      }),
      sync: vi.fn(),
      purge: vi.fn(),
      startScan: vi.fn()
    }
  };
});

const oneSource: Source[] = [
  {
    id: 1,
    type: "radarr",
    name: "Main Radarr",
    baseUrl: "http://127.0.0.1:7878",
    apiKey: "\u2022\u2022\u2022\u20221234",
    enabled: 1,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: "2024-01-01T00:00:00Z"
  }
];

const stats: Stats = {
  total: 7,
  byStatus: { corrupt: 2, suspect: 1, unreachable: 0, missing: 3, purged: 0, unchecked: 0, healthy: 1 },
  bySource: [],
  lastScan: null,
  activeScan: false
};

function renderDashboard() {
  const props = { scope: "", onScopeChange: vi.fn(), goLibrary: vi.fn(), goSettings: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ToastProvider>
          <Dashboard {...props} />
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  );
  return props;
}

const menuItem = (label: string) =>
  screen.getAllByRole("menuitem").find((el) => el.textContent?.startsWith(label));

beforeEach(() => {
  vi.clearAllMocks();
  statsMock.mockResolvedValue(stats);
  sourcesMock.mockResolvedValue({ sources: oneSource });
});

describe("Dashboard", () => {
  it("renders the status cards in the canonical order (problems first, healthy last)", async () => {
    renderDashboard();
    await screen.findByText("Main Radarr");
    const corrupt = screen.getByTitle(STATUS_META.corrupt.description);
    const healthy = screen.getByTitle(STATUS_META.healthy.description);
    expect(corrupt.compareDocumentPosition(healthy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the scan scopes with counts, disabling empty ones instead of hiding them", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(menuItem("Corrupt")).toBeEnabled();
    expect(menuItem("Suspect")).toBeEnabled();
    expect(menuItem("Unreachable")).toBeDisabled();
    expect(menuItem("Missing")).toBeEnabled();
    expect(menuItem("Purged")).toBeDisabled();
    expect(menuItem("Unchecked")).toBeDisabled();
    expect(menuItem("Everything")).toBeEnabled();
    await user.keyboard("{Escape}");
  });

  it("gates every Delete & re-search variant behind the confirm dialog", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("button", { name: "Delete & re-search" }));
    expect(menuItem("Corrupt files")).toBeEnabled();
    expect(menuItem("Suspect files")).toBeEnabled();
    expect(menuItem("Unreachable files")).toBeDisabled();
    expect(menuItem("Everything")).toBeEnabled();

    await user.click(menuItem("Everything")!);
    const dialog = await screen.findByRole("dialog", { name: "Delete 7 file(s) in all servers?" });
    expect(dialog).toHaveTextContent("This cannot be undone.");
    // Cancel must not fire the mutation.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("shows the onboarding state when no sources exist", async () => {
    sourcesMock.mockResolvedValue({ sources: [] });
    renderDashboard();
    expect(await screen.findByText("Get started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a source" })).toBeInTheDocument();
  });
});
