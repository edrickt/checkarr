import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MediaFileDetail } from "../api";
import type { MediaFile } from "../types";
import { formatBytes, formatDuration, formatWhen } from "../utils";
import { STATUS_META } from "../status";
import StatusBadge from "./StatusBadge";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/ConfirmDialog";
import { CloseIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

/** Delete & re-search removes bytes, so it only applies while a file is on disk. */
const ON_DISK_STATUSES = new Set(["corrupt", "suspect", "unreachable", "healthy", "unchecked"]);

/** Why the detail modal has no player: the file is not on disk (or not yet). */
function goneFileMessage(f: MediaFileDetail): string {
  // Status first: a purged row can carry either the old path (until a sync
  // reports no file) or a NULL path (a later sync still found no file), and
  // both mean "deleted, awaiting the replacement", never "not downloaded yet".
  if (f.status === "purged") {
    return 'Deleted at the *arr via Delete & re-search - waiting for the replacement download. "Re-check now" syncs the item first and picks the replacement up once it lands.';
  }
  if (f.path === null) {
    return (
      "No file at the *arr - this " +
      (f.kind === "movie" ? "movie" : "episode") +
      ' is monitored but has not been downloaded yet. "Re-check now" syncs it from the *arr first, so a download that just finished is picked up immediately.'
    );
  }
  if (f.status === "unreachable") {
    return 'The file exists but is not readable (permissions). Fix the file permissions, then use "Re-check now" to test it again.';
  }
  return "The *arr still references this file, but it is not on disk right now. A re-check re-tests it, and a sync picks up a replacement.";
}

export default function DetailModal({ file, onClose }: { file: MediaFile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const detail = useQuery({ queryKey: ["file", file.id], queryFn: () => api.file(file.id) });
  const f: MediaFileDetail = detail.data?.file ?? { ...file, probe: null };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["stats"] });
    queryClient.invalidateQueries({ queryKey: ["file", file.id] });
  };

  const recheck = useMutation({
    mutationFn: () => api.recheck(file.id),
    onSuccess: (r) => {
      toast.success("Re-check finished - " + (STATUS_META[r.status]?.label ?? r.status));
      invalidate();
    },
    onError: (err: Error) => {
      toast.error("Re-check failed: " + err.message);
      // A re-check syncs the item first; if the *arr dropped it, the row is
      // gone - refresh the lists behind the modal so they stop showing it.
      invalidate();
    }
  });

  const purgeOne = useMutation({
    mutationFn: () => api.purgeFile(file.id),
    onSuccess: (data) => {
      invalidate();
      onClose();
      if (data.total === 0) {
        toast.error("Nothing deleted at the *arr - the file may already be gone");
      } else {
        toast.success("Deleted the file and queued a replacement search");
      }
    },
    onError: (err: Error) => toast.error("Delete failed: " + err.message)
  });

  // Queue a search at the *arr for a missing/purged row: the item exists but
  // its file does not, so there is nothing to delete - only something to ask for.
  const research = useMutation({
    mutationFn: () => api.researchFile(file.id),
    onSuccess: (r) => {
      invalidate();
      if (r.searched > 0) {
        const prefix = f.status === "purged" ? "Queued a replacement search at " : "Queued a search at ";
        toast.success(prefix + r.name + " for '" + f.title + "'.");
      } else {
        toast.error(
          "Could not queue a search at " + r.name + (r.errors.length > 0 ? " - " + r.errors[0] : "")
        );
      }
    },
    onError: (err: Error) => toast.error("Search failed: " + err.message)
  });

  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete '" + f.title + "'?",
      body:
        "The file is removed from disk at " +
        f.sourceName +
        " and a replacement search is queued.\n\nThis cannot be undone.",
      confirmLabel: "Delete",
      danger: true
    });
    if (ok) purgeOne.mutate();
  };

  const jumpMiddle = () => {
    const v = videoRef.current;
    if (v && isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration / 2;
  };

  // A player must not be pointed at a file that is known not to be playable: it
  // would 404 (or fail the stream open) and blame the codec. 'purged' means
  // Delete & re-search removed the bytes (the path may be the old one or NULL
  // once a later sync reported no file); 'missing' means the checker could not
  // find the file on disk; 'unreachable' means it exists but cannot be read
  // (EACCES, which the stream endpoint hits only after the headers are sent).
  const playable =
    f.path !== null && f.status !== "purged" && f.status !== "missing" && f.status !== "unreachable";
  const onDisk = f.path !== null && ON_DISK_STATUSES.has(f.status);
  const searchable = f.status === "missing" || f.status === "purged";

  const metadata: { label: string; value: ReactNode }[] = [
    { label: "status", value: <StatusBadge status={f.status} /> },
    { label: "source", value: f.sourceName + " (" + f.sourceType + ")" },
    { label: "quality", value: f.quality ?? "-" },
    { label: "size", value: formatBytes(f.sizeBytes) },
    { label: "duration", value: formatDuration(f.durationS) },
    { label: "container", value: f.container ?? "-" },
    { label: "video", value: f.videoCodec ?? "-" },
    { label: "audio", value: f.audioCodec ?? "-" },
    { label: "checked", value: formatWhen(f.checkedAt) }
  ];

  return (
    <Modal ariaLabel={f.title} onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-4 border-b border-neutral-200 pb-4">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold tracking-tight text-neutral-900">{f.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600">
            <span>{f.subtitle ?? (f.kind === "movie" ? "Movie" : "Episode")}</span>
            <StatusBadge status={f.status} />
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="shrink-0"
        >
          <CloseIcon />
        </Button>
      </div>

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <Button onClick={() => research.mutate()} disabled={research.isPending}>
              {research.isPending ? "Searching..." : "Search now"}
            </Button>
          )}
          <Button onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? "Checking..." : "Re-check now"}
          </Button>
          {onDisk && (
            <Button variant="dangerOutline" onClick={() => void onDelete()} disabled={purgeOne.isPending}>
              {purgeOne.isPending ? "Deleting..." : "Delete & re-search"}
            </Button>
          )}
          {playable && <Button onClick={jumpMiddle}>Jump to middle</Button>}
        </div>

        {!playable ? (
          <div className="border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm leading-6 text-neutral-600">
            {goneFileMessage(f)}
          </div>
        ) : (
          <video
            key={f.id}
            ref={videoRef}
            src={api.streamUrl(f.id)}
            controls
            preload="metadata"
            className="max-h-72 w-full bg-black"
            onError={() =>
              setVideoError(
                "Browser playback failed. The codec may be unsupported by the browser (e.g. DTS audio) - the ffmpeg verdict is the source of truth."
              )
            }
            onLoadedMetadata={() => setVideoError(null)}
          />
        )}

        {videoError && (
          <div role="alert" className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {videoError}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {metadata.map((m) => (
            <div key={m.label}>
              <dt className="text-xs text-neutral-500">{m.label}</dt>
              <dd className="mt-0.5 text-sm text-neutral-700">{m.value}</dd>
            </div>
          ))}
        </dl>

        <div>
          <div className="text-xs text-neutral-500">path</div>
          <p className="mt-0.5 break-all font-mono text-xs text-neutral-600">
            {f.path ?? "(no file at the *arr yet)"}
          </p>
        </div>

        {f.errorDetail && (
          <div>
            <div className="text-xs text-neutral-500">ffmpeg findings</div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-red-700">
              {f.errorDetail}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}
