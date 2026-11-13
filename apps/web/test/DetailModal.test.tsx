import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import DetailModal from "../src/components/DetailModal";
import type { MediaFile } from "../src/types";
import { ConfirmProvider } from "../src/ui/ConfirmDialog";
import { ToastProvider } from "../src/ui/Toast";

const fileMock = vi.fn();
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      file: (...args: unknown[]) => fileMock(...args),
      streamUrl: (id: number) => "/api/files/" + id + "/stream",
      recheck: vi.fn(),
      purgeFile: vi.fn()
    }
  };
});

function detail(over: Partial<MediaFile> & { id: number }): MediaFile {
  return {
    sourceId: 1,
    sourceType: "radarr",
    sourceName: "Main Radarr",
    kind: "movie",
    title: "A Movie",
    subtitle: "2020",
    path: "/movies/a.mkv",
    sizeBytes: 1000,
    quality: "WEBDL-1080p",
    status: "healthy",
    durationS: 3600,
    container: "mkv",
    videoCodec: "h264",
    audioCodec: "aac",
    errorDetail: null,
    checkedAt: null,
    ...over
  };
}

function renderModal(file: MediaFile) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ToastProvider>
          <DetailModal file={file} onClose={() => {}} />
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DetailModal stream player", () => {
  it("does not point a player at a file that Delete & re-search deleted", async () => {
    const file = detail({ id: 1, status: "purged" });
    fileMock.mockImplementation(async () => ({ file: { ...file, probe: null } }));
    renderModal(file);
    expect(await screen.findByText(/waiting for the replacement download/i)).toBeInTheDocument();
    // The old path still exists on the row until sync swaps the replacement
    // in, but the bytes were deleted: a <video> would 404 and blame the codec.
    expect(document.querySelector("video")).toBeNull();
    expect(screen.queryByText(/Browser playback failed/i)).not.toBeInTheDocument();
  });

  it("does not point a player at a file the checker found missing on disk", async () => {
    const file = detail({ id: 2, status: "missing" });
    fileMock.mockImplementation(async () => ({ file: { ...file, probe: null } }));
    renderModal(file);
    expect(await screen.findByText(/not on disk/i)).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("still plays a file the library reports as present", async () => {
    const file = detail({ id: 3, status: "healthy" });
    fileMock.mockImplementation(async () => ({ file: { ...file, probe: null } }));
    renderModal(file);
    expect(await screen.findByText("A Movie")).toBeInTheDocument();
    expect(document.querySelector("video")).not.toBeNull();
  });

  it("keeps the monitored-but-not-downloaded note for fileless rows", async () => {
    const file = detail({ id: 4, status: "missing", path: null });
    fileMock.mockImplementation(async () => ({ file: { ...file, probe: null } }));
    renderModal(file);
    expect((await screen.findAllByText(/No file at the \*arr/i)).length).toBeGreaterThan(0);
    expect(document.querySelector("video")).toBeNull();
  });
});
