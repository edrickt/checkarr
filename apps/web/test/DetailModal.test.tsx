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
    // The row may still carry the old path until a later sync reports no file
    // (which keeps it purged and NULLs the path), but the bytes were deleted:
    // a <video> would 404 and blame the codec.
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

  it("still explains the purged state after a later sync cleared the path", async () => {
    // A sync that still sees no file at the *arr NULLs the path while keeping
    // status 'purged' (sync.ts unfile rule). The message must not fall back to
    // "has not been downloaded yet" - the file was deleted by the user.
    const file = detail({ id: 5, status: "purged", path: null });
    fileMock.mockImplementation(async () => ({ file: { ...file, probe: null } }));
    renderModal(file);
    expect(await screen.findByText(/waiting for the replacement download/i)).toBeInTheDocument();
    expect(screen.queryByText(/has not been downloaded yet/i)).not.toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("does not point a player at a file that exists but is unreadable (permissions)", async () => {
    // /api/files/:id/stream stats OK on an EACCES file and fails only when the
    // stream opens, so the browser blames the codec. The checker already knows
    // the file is unreachable: show that instead of a player.
    const file = detail({ id: 6, status: "unreachable" });
    fileMock.mockImplementation(async () => ({ file: { ...file, probe: null } }));
    renderModal(file);
    expect(await screen.findByText(/not readable \(permissions\)/i)).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });
});
