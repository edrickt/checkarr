import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MediaFileDetail } from "../api";
import type { MediaFile } from "../types";
import { formatBytes, formatDuration, formatWhen } from "../utils";
import { STATUS_META } from "../status";
import StatusBadge from "./StatusBadge";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/ConfirmDialog";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

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

  return (
    <Modal ariaLabel={f.title} onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{f.title}</h2>
          <p className="text-sm text-neutral-500">
            {f.subtitle ?? (f.kind === "movie" ? "Movie" : "Episode")}
          </p>
        </div>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {f.path === null ? (
        <div className="mb-3 border border-neutral-300 px-3 py-2 text-xs text-neutral-600">
          No file at the *arr - this {f.kind === "movie" ? "movie" : "episode"} is monitored but has not been
          downloaded yet. "Re-check now" syncs it from the *arr first, so a download that just finished is
          picked up immediately.
        </div>
      ) : (
        <video
          key={f.id}
          ref={videoRef}
          src={api.streamUrl(f.id)}
          controls
          preload="metadata"
          className="mb-3 max-h-72 w-full bg-black"
          onError={() =>
            setVideoError(
              "Browser playback failed. The codec may be unsupported by the browser (e.g. DTS audio) - the ffmpeg verdict is the source of truth."
            )
          }
          onLoadedMetadata={() => setVideoError(null)}
        />
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button onClick={jumpMiddle} disabled={f.path === null}>
          Jump to middle
        </Button>
        <Button onClick={() => recheck.mutate()} disabled={recheck.isPending}>
          {recheck.isPending ? "Checking..." : "Re-check now"}
        </Button>
        <Button
          variant="danger"
          onClick={() => void onDelete()}
          disabled={purgeOne.isPending || f.path === null}
          title={f.path === null ? "Nothing to delete at the *arr yet" : undefined}
        >
          {purgeOne.isPending ? "Deleting..." : "Delete & re-search"}
        </Button>
      </div>
      {videoError && (
        <div className="mb-3 border border-amber-300 px-3 py-2 text-xs text-amber-700">{videoError}</div>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={f.status} />
        </div>
        <div>
          <span className="text-neutral-400">source:</span> {f.sourceName} ({f.sourceType})
        </div>
        <div>
          <span className="text-neutral-400">quality:</span> {f.quality ?? "-"}
        </div>
        <div>
          <span className="text-neutral-400">size:</span> {formatBytes(f.sizeBytes)}
        </div>
        <div>
          <span className="text-neutral-400">duration:</span> {formatDuration(f.durationS)}
        </div>
        <div>
          <span className="text-neutral-400">container:</span> {f.container ?? "-"}
        </div>
        <div>
          <span className="text-neutral-400">video:</span> {f.videoCodec ?? "-"}
        </div>
        <div>
          <span className="text-neutral-400">audio:</span> {f.audioCodec ?? "-"}
        </div>
        <div>
          <span className="text-neutral-400">checked:</span> {formatWhen(f.checkedAt)}
        </div>
      </dl>

      <div className="mt-3">
        <div className="text-xs text-neutral-400">path</div>
        <p className="break-all font-mono text-xs text-neutral-600">
          {f.path ?? "(no file at the *arr yet)"}
        </p>
      </div>

      {f.errorDetail && (
        <div className="mt-3">
          <div className="text-xs text-neutral-400">ffmpeg findings</div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-red-700">
            {f.errorDetail}
          </pre>
        </div>
      )}
    </Modal>
  );
}
