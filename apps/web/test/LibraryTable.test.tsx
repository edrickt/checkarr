import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LibraryTable from "../src/components/LibraryTable";
import type { LibraryQuery } from "../src/router";
import type { MediaFile } from "../src/types";

const filesMock = vi.fn();
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      files: (...args: unknown[]) => filesMock(...args),
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
      <LibraryTable query={{ ...baseQuery, ...query }} onQueryChange={onQueryChange} />
    </QueryClientProvider>
  );
  return { onQueryChange };
}

beforeEach(() => {
  filesMock.mockReset();
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

  it("pages through results", async () => {
    filesMock.mockResolvedValue({ items, total: 120, page: 1, pageSize: 50 });
    const { onQueryChange } = renderTable();
    await screen.findByText("Alpha");
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
      fireEvent.change(screen.getByPlaceholderText("Search title or path..."), {
        target: { value: "star" }
      });
      expect(onQueryChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(onQueryChange).toHaveBeenCalledWith({ q: "star", page: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
