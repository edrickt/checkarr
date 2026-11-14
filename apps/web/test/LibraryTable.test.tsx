import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LibraryTable from "../src/components/LibraryTable";
import type { LibraryQuery } from "../src/router";
import type { MediaFile } from "../src/types";
import { ConfirmProvider } from "../src/ui/ConfirmDialog";
import { ToastProvider } from "../src/ui/Toast";

const filesMock = vi.fn();
const researchMock = vi.fn();
const fileMock = vi.fn();
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      files: (...args: unknown[]) => filesMock(...args),
      file: (...args: unknown[]) => fileMock(...args),
      researchFile: (...args: unknown[]) => researchMock(...args),
      currentScan: async () => ({ run: null, active: false }),
      sources: async () => ({
        sources: [
          {
            id: 1,
            type: "radarr",
            name: "R",
            baseUrl: "http://127.0.0.1:1",
            apiKey: "\u2022\u2022\u2022\u20221234",
            enabled: 1,
            lastSyncAt: null,
            lastSyncError: null,
            createdAt: "2024-01-01T00:00:00Z"
          }
        ]
      })
    }
  };
});

function row(over: Partial<MediaFile> & { id: number }): MediaFile {
  return {
    sourceId: 1,
    sourceType: "radarr",
    sourceName: "R",
    kind: "movie",
    title: "A Movie",
    subtitle: null,
    path: "/movies/a.mkv",
    sizeBytes: 1000,
    quality: "WEBDL-1080p",
    status: "corrupt",
    durationS: 3600,
    container: "mkv",
    videoCodec: "h264",
    audioCodec: "aac",
    errorDetail: null,
    checkedAt: null,
    ...over
  };
}

const items: MediaFile[] = [
  row({ id: 1, title: "Alpha", path: "/movies/alpha.mkv" }),
  row({ id: 2, title: "Beta", path: null, status: "missing" })
];

const baseQuery: LibraryQuery = {
  status: "",
  sourceId: "",
  q: "",
  page: 1,
  pageSize: 50,
  sort: "",
  dir: "desc"
};

function renderTable(query: Partial<LibraryQuery> = {}) {
  const onQueryChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ToastProvider>
          <LibraryTable query={{ ...baseQuery, ...query }} onQueryChange={onQueryChange} />
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  );
  return { onQueryChange };
}

beforeEach(() => {
  filesMock.mockReset();
  researchMock.mockReset();
  fileMock.mockReset();
  filesMock.mockResolvedValue({ items, total: 2, page: 1, pageSize: 50 });
});

describe("LibraryTable", () => {
  it("sorts through the API params, toggling direction per column", async () => {
    const { onQueryChange } = renderTable();
    await screen.findByText("Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(onQueryChange).toHaveBeenCalledWith({ sort: "size", dir: "desc", page: 1 });
  });

  it("offers every status in the canonical wording (never Unscanned)", async () => {
    renderTable();
    await screen.findByText("Alpha");
    const names = [
      "All statuses",
      "Corrupt",
      "Suspect",
      "Unreachable",
      "Missing",
      "Purged",
      "Unchecked",
      "Healthy"
    ];
    for (const name of names) {
      expect(screen.getByRole("option", { name })).toBeInTheDocument();
    }
  });

  it("hides per-row delete behind the actions menu and disables it when nothing exists at the *arr", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByText("Beta");

    await user.click(screen.getByRole("button", { name: "Actions for Beta" }));
    const betaDelete = screen.getByRole("menuitem", { name: /Delete & re-search/ });
    expect(betaDelete).toBeDisabled();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    const alphaDelete = screen.getByRole("menuitem", { name: /Delete & re-search/ });
    expect(alphaDelete).toBeEnabled();
  });

  it("gates Delete & re-search on a file still being on disk, not just on status", async () => {
    const user = userEvent.setup();
    filesMock.mockResolvedValue({
      items: [
        row({ id: 1, title: "Corrupt On Disk", status: "corrupt", path: "/a.mkv" }),
        row({ id: 2, title: "Purged Old Path", status: "purged", path: "/b.mkv" }),
        row({ id: 3, title: "Healthy On Disk", status: "healthy", path: "/c.mkv" }),
        row({ id: 4, title: "Unchecked No File", status: "unchecked", path: null })
      ],
      total: 4,
      page: 1,
      pageSize: 50
    });
    renderTable();

    const expectations: [string, boolean][] = [
      ["Corrupt On Disk", true],
      ["Purged Old Path", false],
      ["Healthy On Disk", true],
      ["Unchecked No File", false]
    ];
    for (const [title, enabled] of expectations) {
      await user.click(await screen.findByRole("button", { name: "Actions for " + title }));
      const item = screen.getByRole("menuitem", { name: /Delete & re-search/ });
      if (enabled) expect(item).toBeEnabled();
      else expect(item).toBeDisabled();
      await user.keyboard("{Escape}");
    }
  });

  it("queues a search for a missing row and confirms it with a toast", async () => {
    const user = userEvent.setup();
    researchMock.mockResolvedValue({ id: 2, name: "R", type: "radarr", searched: 1, errors: [] });
    renderTable();
    await screen.findByText("Beta");

    await user.click(screen.getByRole("button", { name: "Actions for Beta" }));
    await user.click(screen.getByRole("menuitem", { name: /Search now/ }));

    expect(researchMock).toHaveBeenCalledWith(2);
    expect(await screen.findByText("Queued a search at R for 'Beta'.")).toBeInTheDocument();
  });

  it("keeps Search now in the menu for every row, enabled only for missing and purged", async () => {
    const user = userEvent.setup();
    filesMock.mockResolvedValue({
      items: [
        row({ id: 1, title: "Corrupt On Disk", status: "corrupt", path: "/a.mkv" }),
        row({ id: 2, title: "Missing No File", status: "missing", path: null }),
        row({ id: 3, title: "Purged Old Path", status: "purged", path: "/b.mkv" }),
        row({ id: 4, title: "Healthy On Disk", status: "healthy", path: "/c.mkv" })
      ],
      total: 4,
      page: 1,
      pageSize: 50
    });
    renderTable();

    const expectations: [string, boolean][] = [
      ["Corrupt On Disk", false],
      ["Missing No File", true],
      ["Purged Old Path", true],
      ["Healthy On Disk", false]
    ];
    for (const [title, enabled] of expectations) {
      await user.click(await screen.findByRole("button", { name: "Actions for " + title }));
      const item = screen.getByRole("menuitem", { name: /Search now/ });
      if (enabled) expect(item).toBeEnabled();
      else {
        expect(item).toBeDisabled();
        expect(item).toHaveTextContent("Only missing and purged rows can be searched");
      }
      await user.keyboard("{Escape}");
    }
  });

  it("opens the detail modal from the Details menu item", async () => {
    const user = userEvent.setup();
    fileMock.mockResolvedValue({ file: { ...items[0], probe: null } });
    renderTable();
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: /Details/ }));

    expect(await screen.findByRole("dialog", { name: "Alpha" })).toBeInTheDocument();
    expect(fileMock).toHaveBeenCalledWith(1);
  });

  it("pages through results and reports the visible range", async () => {
    filesMock.mockResolvedValue({ items, total: 120, page: 1, pageSize: 50 });
    const { onQueryChange } = renderTable();
    await screen.findByText("Alpha");
    expect(screen.getByText("1\u201350 of 120")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onQueryChange).toHaveBeenCalledWith({ page: 2 });
  });

  it("does not clamp a deep-linked page while its listing is still loading", async () => {
    let resolveFiles!: (value: unknown) => void;
    filesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFiles = resolve;
      })
    );
    const { onQueryChange } = renderTable({ page: 2 });
    await new Promise((r) => setTimeout(r, 50));
    // The old clamp fired on the empty loading result and sent the user to
    // page 1 before the requested page ever had data.
    expect(onQueryChange).not.toHaveBeenCalledWith({ page: 1 });
    resolveFiles({ items, total: 120, page: 2, pageSize: 50 });
    await screen.findByText("Alpha");
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it("clamps a page that is past the end once the listing has loaded", async () => {
    filesMock.mockResolvedValue({ items, total: 2, page: 3, pageSize: 50 });
    const { onQueryChange } = renderTable({ page: 3 });
    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith({ page: 1 }));
  });

  it("pushes the debounced search text into the query", async () => {
    vi.useFakeTimers();
    try {
      const { onQueryChange } = renderTable();
      fireEvent.change(screen.getByPlaceholderText("Search title or path"), {
        target: { value: "star" }
      });
      expect(onQueryChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(onQueryChange).toHaveBeenCalledWith({ q: "star", page: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Clear filters when a filter hides every row", async () => {
    const user = userEvent.setup();
    filesMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    const { onQueryChange } = renderTable({ q: "star" });

    expect(await screen.findByText("No files match")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onQueryChange).toHaveBeenCalledWith({ q: "", status: "", sourceId: "", page: 1 });
  });

  it("points an empty unfiltered library at the Dashboard", async () => {
    filesMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    renderTable();

    expect(await screen.findByText("No files yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the Dashboard" })).toHaveAttribute("href", "#/dashboard");
  });
});
