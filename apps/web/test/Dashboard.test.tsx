import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "../src/components/Dashboard";
import type { Source, Stats } from "../src/types";
import { ConfirmProvider } from "../src/ui/ConfirmDialog";
import { ToastProvider } from "../src/ui/Toast";

const statsMock = vi.fn();
const sourcesMock = vi.fn();
const purgeMock = vi.fn();
const researchMock = vi.fn();

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
      purge: (...args: unknown[]) => purgeMock(...args),
      researchMissing: (...args: unknown[]) => researchMock(...args),
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
  total: 8,
  byStatus: { corrupt: 2, suspect: 1, unreachable: 0, missing: 3, purged: 1, unchecked: 0, healthy: 1 },
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

const rowFor = (label: string) => {
  const node = screen.getByText(label, { selector: "span" });
  const li = node.closest("li");
  if (!li) throw new Error("row not found for " + label);
  return within(li);
};

beforeEach(() => {
  vi.clearAllMocks();
  purgeMock.mockResolvedValue({ results: [], total: 0, synced: [] });
  researchMock.mockResolvedValue({ results: [], total: 0, synced: [] });
  statsMock.mockResolvedValue(stats);
  sourcesMock.mockResolvedValue({ sources: oneSource });
});

describe("Dashboard", () => {
  it("orders the status rows by severity: problems, then waiting, then the rest", async () => {
    renderDashboard();
    await screen.findByText("Main Radarr");
    const order = [
      screen.getByText("Corrupt"),
      screen.getByText("Suspect"),
      screen.getByText("Unreachable"),
      screen.getByText("Missing"),
      screen.getByText("Purged"),
      screen.getByText(/^Unchecked/),
      screen.getByText(/^Healthy/)
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("shows the scan scopes with counts, disabling empty ones instead of hiding them", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("button", { name: "Scan library" }));
    expect(menuItem("Corrupt")).toBeEnabled();
    expect(menuItem("Suspect")).toBeEnabled();
    expect(menuItem("Unreachable")).toBeDisabled();
    expect(menuItem("Missing")).toBeEnabled();
    expect(menuItem("Purged")).toBeEnabled();
    expect(menuItem("Unchecked")).toBeDisabled();
    expect(menuItem("Everything")).toBeEnabled();
    await user.keyboard("{Escape}");
  });

  it("gates a status delete behind the confirm dialog", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText("Main Radarr");

    await user.click(rowFor("Corrupt").getByRole("button", { name: "Delete & re-search" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 corrupt files in all libraries?" });
    expect(dialog).toHaveTextContent("This cannot be undone.");
    // Cancel must not fire the mutation.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(purgeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("keeps the delete-everything escape hatch behind the section menu and the confirm dialog", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText("Main Radarr");

    await user.click(screen.getByRole("button", { name: "More actions for problem files" }));
    await user.click(menuItem("Delete every file in scope")!);
    const dialog = await screen.findByRole("dialog", { name: "Delete 8 files in all libraries?" });
    expect(dialog).toHaveTextContent("healthy ones included");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("queues a search for missing and purged rows from the row itself", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText("Main Radarr");

    await user.click(rowFor("Purged").getByRole("button", { name: "Search now" }));
    expect(researchMock).toHaveBeenCalledWith(undefined, "purged");

    await user.click(rowFor("Missing").getByRole("button", { name: "Search now" }));
    expect(researchMock).toHaveBeenCalledWith(undefined, "missing");
  });

  it("shows the onboarding state when no sources exist", async () => {
    sourcesMock.mockResolvedValue({ sources: [] });
    renderDashboard();
    expect(await screen.findByText("Get started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a source" })).toBeInTheDocument();
  });
});
